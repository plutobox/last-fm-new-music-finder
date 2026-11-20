package com.pluto.box

import org.scalajs.dom

import scala.collection.mutable
import scala.concurrent.{Future, Promise}
import scala.scalajs.concurrent.JSExecutionContext.Implicits.queue
import scala.scalajs.js
import scala.scalajs.js.Thenable.Implicits.*
import scala.util.{Failure, Success}

// One of the Parquet files in data/songs/manifest.json, with the listener counts it covers.
final case class SongFile(name: String, songs: Int, bytes: Double, minListeners: Int, maxListeners: Int)

// What the manifest says about the song table. The songs themselves stay in the files until a search reads them.
final case class Catalog(
  builtAt: String,
  version: String,
  count: Int,
  genres: Vector[(String, Int)],
  files: Vector[SongFile]
):
  val maxListeners: Int = files.map(_.maxListeners).maxOption.getOrElse(1)

object Catalog:
  def parse(text: String): Catalog =
    val root = js.JSON.parse(text)
    val parquet = root.parquet
    // Older files use a layout this page can't read (PARQUET_FORMAT in scripts/songs-parquet.mjs).
    if js.isUndefined(parquet) || js.isUndefined(parquet.format) || parquet.format.asInstanceOf[Int] < 2 then throw new Exception("the song files are still being rebuilt for this version of the site, so try again in a couple of hours")
    val files = parquet.files.asInstanceOf[js.Array[js.Dynamic]].toVector.map: f =>
      SongFile(
        name = f.name.asInstanceOf[String],
        songs = f.songs.asInstanceOf[Int],
        bytes = f.bytes.asInstanceOf[Double],
        minListeners = f.listeners.min.asInstanceOf[Int],
        maxListeners = f.listeners.max.asInstanceOf[Int]
      )
    val genres =
      if js.isUndefined(root.genres) then Vector.empty
      else root.genres.asInstanceOf[js.Array[js.Array[js.Any]]].toVector.map(g => (g(0).asInstanceOf[String], g(1).asInstanceOf[Int]))
    Catalog(root.built_at.asInstanceOf[String], root.version.asInstanceOf[String], root.count.asInstanceOf[Int], genres, files)

// The lowest and highest value of a column in one row group, from the file's statistics.
final case class Span(min: Double, max: Double)

// One row group: rows [rowStart, rowEnd) of its file, with the statistics a search uses to skip it.
final class Group(val file: OpenFile, val index: Int, val rowStart: Double, val rowEnd: Double,
                  val spans: Map[String, Span], val nulls: Map[String, Double]):
  def rows: Int = (rowEnd - rowStart).toInt
  def span(column: String): Option[Span] = spans.get(column)
  // Statistics are optional in Parquet: a column without them could hold anything.
  def allNull(column: String): Boolean = nulls.get(column).contains(rowEnd - rowStart)
  def noNulls(column: String): Boolean = nulls.get(column).contains(0.0)
  val key: String = s"${file.info.name}#$index"
  // Where the group's first row sits across all the files, in manifest order, so every row has its own number.
  val position: Double = file.index * 1e8 + rowStart

// index is the file's place in the manifest.
final class OpenFile(val info: SongFile, val index: Int, val buffer: AsyncBuffer, val metadata: FileMetaData):
  val groups: Vector[Group] =
    var start = 0.0
    metadata.row_groups.toVector.zipWithIndex.map: (rg, i) =>
      val rows = SongStore.number(rg.num_rows)
      val spans = mutable.Map[String, Span]()
      val nulls = mutable.Map[String, Double]()
      for chunk <- rg.columns; meta <- chunk.meta_data.toOption do
        val name = meta.path_in_schema(0)
        meta.statistics.toOption.foreach: stats =>
          stats.null_count.toOption.foreach(n => nulls(name) = SongStore.number(n))
          (stats.min_value.toOption, stats.max_value.toOption) match
            case (Some(lo), Some(hi)) if js.typeOf(lo) == "number" || js.typeOf(lo) == "bigint" =>
              spans(name) = Span(SongStore.number(lo), SongStore.number(hi))
            case _ => ()
      val group = new Group(this, i, start, start + rows, spans.toMap, nulls.toMap)
      start += rows
      group

// Reads the Parquet files over HTTP range requests, one row group and a few columns at a time. Decoded columns are
// kept up to a memory budget, so going back to a search doesn't download them again, and a phone doesn't run out.
final class SongStore(catalog: Catalog, dataRoot: String):
  private val opened = mutable.Map[String, Future[OpenFile]]()

  def open(file: SongFile): Future[OpenFile] =
    opened.getOrElseUpdate(
      file.name, {
        val address = s"$dataRoot/songs/${file.name}?v=${catalog.version}"
        val future = for
          buffer <- Hyparquet.asyncBufferFromUrl(new UrlOptions {
            val url = address
            val byteLength = file.bytes
            val fetch = SongStore.fetchWithRetries
          }).toFuture
          metadata <- Hyparquet.parquetMetadataAsync(buffer, new MetadataOptions { val initialFetchSize = 65536 }).toFuture
        yield new OpenFile(file, catalog.files.indexOf(file), buffer, metadata)
        // A failed open is tried again next time, rather than remembered.
        future.failed.foreach(_ => opened.remove(file.name))
        future
      }
    )

  // Least recently used first, each with its estimated size in bytes.
  private val cache = mutable.LinkedHashMap[String, (Future[js.Array[js.Any]], Double)]()
  private var cached = 0.0
  private val budget = 48e6

  private def remember(key: String, value: Future[js.Array[js.Any]], size: Double): Unit =
    cache.remove(key).foreach((_, s) => cached -= s)
    cache(key) = (value, size)
    cached += size
    while cached > budget && cache.size > 1 do
      val (oldest, (_, s)) = cache.head
      cache.remove(oldest)
      cached -= s

  // The named columns of one row group, as arrays with one value per row.
  def columns(group: Group, names: Seq[String]): Future[Map[String, js.Array[js.Any]]] =
    val wanted = names.distinct
    def key(name: String) = s"${group.key}/$name"
    val found = mutable.Map[String, Future[js.Array[js.Any]]]()
    val missing = mutable.ArrayBuffer[String]()
    for name <- wanted do
      cache.get(key(name)) match
        case Some((future, size)) =>
          found(name) = future
          remember(key(name), future, size) // now the most recently used
        case None => missing += name
    if missing.nonEmpty then
      val promises = missing.map(name => name -> Promise[js.Array[js.Any]]()).toMap
      // Counted as small until read, then re-counted at its real size.
      for name <- missing do
        found(name) = promises(name).future
        remember(key(name), promises(name).future, 0)
      val read = Hyparquet.parquetRead(new ReadOptions {
        val file = group.file.buffer
        val metadata = group.file.metadata
        val columns = js.Array(missing.toSeq*)
        val rowStart = group.rowStart
        val rowEnd = group.rowEnd
        override val onChunk = js.defined((chunk: ColumnChunkData) =>
          promises.get(chunk.columnName).foreach(_.trySuccess(chunk.columnData)))
      }).toFuture
      read.onComplete: outcome =>
        for (name, promise) <- promises do
          outcome match
            case Failure(e) =>
              promise.tryFailure(e)
              cache.remove(key(name)).foreach((_, s) => cached -= s)
            case Success(_) =>
              promise.tryFailure(new Exception(s"the song files have no \"$name\" column"))
              promise.future.value.collect { case Success(values) =>
                if cache.get(key(name)).exists(_._1 eq promise.future) then
                  // Artist and song names are most of the data and would push everything else out, so they're
                  // only shared while being read.
                  if SongStore.textColumns(name) then cache.remove(key(name))
                  else remember(key(name), promise.future, SongStore.size(values))
              }
    Future.sequence(wanted.map(name => found(name).map(name -> _))).map(_.toMap)

  // Whole songs for the given rows of one group (indices from the group's first row), read only as far as needed.
  def songs(group: Group, indices: Seq[Int]): Future[Map[Int, Song]] =
    if indices.isEmpty then Future.successful(Map.empty)
    else
      val (first, last) = (indices.min, indices.max)
      Hyparquet.parquetReadObjects(new ReadOptions {
        val file = group.file.buffer
        val metadata = group.file.metadata
        val columns = js.Array(SongStore.songColumns*)
        val rowStart = group.rowStart + first
        val rowEnd = group.rowStart + last + 1
      }).toFuture.map: rows =>
        indices.map(i => i -> SongStore.song(rows(i - first))).toMap

object SongStore:
  val songColumns: Seq[String] = Seq("artist", "song", "genres", "listeners", "plays", "loved_by", "year", "youtube_id", "id")
  val textColumns: Set[String] = Set("artist", "song")

  // Parquet counts and 64-bit columns come back as BigInt; everything here fits in a Double.
  def number(value: Any): Double =
    if js.typeOf(value) == "bigint" then js.Dynamic.global.Number(value.asInstanceOf[js.Any]).asInstanceOf[Double]
    else value.asInstanceOf[Double]

  def isMissing(value: Any): Boolean = value == null || js.isUndefined(value)

  // A search can make hundreds of requests, and on a phone's connection one of them sometimes fails ("Load failed"
  // in Safari). Each is tried up to 3 more times, after 0.5, 1.5 and 3 seconds, before the search gives up.
  private val retryDelays = Seq(500, 1500, 3000)

  private def pause(ms: Int): Future[Unit] =
    val done = Promise[Unit]()
    js.timers.setTimeout(ms.toDouble)(done.success(()))
    done.future

  val fetchWithRetries: js.Function2[js.Any, js.UndefOr[js.Any], js.Promise[dom.Response]] = (input, init) =>
    import scala.scalajs.js.JSConverters.*
    def attempt(delays: Seq[Int]): Future[dom.Response] =
      val request = dom.fetch(
        input.asInstanceOf[dom.RequestInfo],
        init.getOrElse(js.Object()).asInstanceOf[dom.RequestInit]
      ).toFuture
      delays match
        case Nil => request
        case wait +: later =>
          request
            .transformWith:
              case Success(response) if response.status < 500 => Future.successful(response)
              case _ => pause(wait).flatMap(_ => attempt(later))
    attempt(retryDelays).toJSPromise

  def song(row: js.Dictionary[js.Any]): Song =
    def optional(name: String) = row.get(name).filterNot(isMissing)
    Song(
      artist = row("artist").asInstanceOf[String],
      title = row("song").asInstanceOf[String],
      genres = optional("genres").fold(Vector.empty[String])(_.asInstanceOf[js.Array[String]].toVector),
      listeners = number(row("listeners")).toInt,
      plays = number(row("plays")).toInt,
      lovedBy = number(row("loved_by")).toInt,
      year = optional("year").map(number(_).toInt),
      youtubeId = optional("youtube_id").map(_.asInstanceOf[String]),
      id = optional("id").map(number(_).toInt)
    )

  // A rough size in bytes, for the cache's budget.
  def size(values: js.Array[js.Any]): Double =
    val sample = values.iterator.take(64).toVector
    val each =
      if sample.isEmpty then 8.0
      else
        def text(v: js.Any) = 40.0 + 2 * v.asInstanceOf[String].length
        sample.map { v =>
          if js.typeOf(v) == "string" then text(v)
          else if js.Array.isArray(v) then 48.0 + v.asInstanceOf[js.Array[js.Any]].map(text).sum
          else 8.0
        }.sum / sample.size
    16 + values.length * each
