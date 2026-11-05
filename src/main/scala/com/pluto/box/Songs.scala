package com.pluto.box

import scala.scalajs.js
import scala.util.Random

final case class Song(
  artist: String,
  title: String,
  genres: Vector[String],
  listeners: Int,
  plays: Int,
  lovedBy: Int,
  year: Option[Int],
  youtubeId: Option[String],
  id: Option[Int] = None
):
  val artistLower: String = artist.toLowerCase
  val titleLower: String = title.toLowerCase

  // Last.fm's own URL style: spaces become "+", everything else percent-encoded.
  def url: String =
    def part(s: String) = js.URIUtils.encodeURIComponent(s).replace("%20", "+")
    s"https://www.last.fm/music/${part(artist)}/_/${part(title)}"

  def youtubeSearchUrl: String =
    s"https://www.youtube.com/results?search_query=${js.URIUtils.encodeURIComponent(s"$artist $title")}"

enum SortBy(val key: String, val label: String):
  case MostListeners extends SortBy("listeners-desc", "Most listeners")
  case FewestListeners extends SortBy("listeners-asc", "Fewest listeners")
  case MostPlays extends SortBy("plays-desc", "Most plays")
  case FewestPlays extends SortBy("plays-asc", "Fewest plays")
  case MostLoved extends SortBy("loved-desc", "Most loved")
  case FewestLoved extends SortBy("loved-asc", "Fewest loved")
  case Newest extends SortBy("year-desc", "Newest")
  case Oldest extends SortBy("year-asc", "Oldest")
  case ArtistAZ extends SortBy("artist-asc", "Artist, A to Z")
  case TitleAZ extends SortBy("title-asc", "Song, A to Z")
  case Shuffle extends SortBy("random", "Random")

object SortBy:
  def fromKey(key: String): SortBy = values.find(_.key == key).getOrElse(MostListeners)

// The number fields stay strings so a half-typed or empty box simply doesn't filter.
final case class Query(
  genres: Set[String] = Set.empty,
  matchAllGenres: Boolean = false,
  excludedGenres: Set[String] = Set.empty,
  artist: String = "",
  title: String = "",
  sort: SortBy = SortBy.MostListeners,
  minListeners: String = "",
  maxListeners: String = "",
  minPlays: String = "",
  maxPlays: String = "",
  minLoved: String = "",
  maxLoved: String = "",
  yearFrom: String = "",
  yearTo: String = "",
  playableOnly: Boolean = false,
  limit: Int = 10
)

// data/songs/manifest.json, which lists the split files that make up the song table.
final case class Manifest(builtAt: String, version: String, columns: js.Array[String], parts: Vector[String])

final case class Library(songs: Vector[Song], builtAt: String):
  val maxListeners: Int = songs.iterator.map(_.listeners).maxOption.getOrElse(1)
  // Every genre with its song count, biggest first.
  val genres: Vector[(String, Int)] =
    songs.flatMap(_.genres).groupMapReduce(identity)(_ => 1)(_ + _).toVector.sortBy((g, n) => (-n, g))
  // Built on the first "Like this song?" click, as most visits won't need it.
  lazy val byId: js.Map[Int, Song] =
    val map = new js.Map[Int, Song]()
    for s <- songs; id <- s.id do map(id) = s
    map

final case class Result(matched: Int, songs: Vector[Song])

// A song the listeners of another song also listen to or love.
final case class SongMatch(song: Song, sharedListeners: Int)

object Songs:
  private def number(s: String): Option[Int] = s.trim.toIntOption

  def parseManifest(text: String): Manifest =
    val root = js.JSON.parse(text)
    Manifest(
      builtAt = root.built_at.asInstanceOf[String],
      version = root.version.asInstanceOf[String],
      columns = root.columns.asInstanceOf[js.Array[String]],
      parts = root.parts.asInstanceOf[js.Array[js.Dynamic]].toVector.map(_.name.asInstanceOf[String])
    )

  // Joins the split files, in the order the manifest lists them.
  def join(manifest: Manifest, parts: Vector[String]): Library =
    val rows = parts.iterator.flatMap(text => js.JSON.parse(text).rows.asInstanceOf[js.Array[js.Array[js.Any]]].iterator)
    Library(readRows(manifest.columns, rows), manifest.builtAt)

  // data/similar/manifest.json: when the matches were built, and how many files they're split across.
  def parseMatchFiles(text: String): (String, Int) =
    val root = js.JSON.parse(text)
    (root.built_at.asInstanceOf[String], root.shards.asInstanceOf[Int])

  // One of the split match files, already best first. Skips any song no longer in the public list.
  def parseMatches(text: String, library: Library, id: Int): Vector[SongMatch] =
    val root = js.JSON.parse(text).asInstanceOf[js.Dictionary[js.Array[js.Array[Int]]]]
    root.get(id.toString).toVector.flatMap(_.toVector).flatMap: pair =>
      library.byId.get(pair(0)).map(song => SongMatch(song, pair(1)))

  // The older single-file form.
  def parse(text: String): Library =
    val root = js.JSON.parse(text)
    val rows = root.rows.asInstanceOf[js.Array[js.Array[js.Any]]]
    Library(readRows(root.columns.asInstanceOf[js.Array[String]], rows.iterator), root.built_at.asInstanceOf[String])

  // Reads the columns by name, so adding a column can't shift these.
  private def readRows(columns: js.Array[String], rows: Iterator[js.Array[js.Any]]): Vector[Song] =
    def column(name: String): Int =
      val i = columns.indexOf(name)
      if i < 0 then throw new Exception(s"the song data has no \"$name\" column")
      i
    val (artist, title, genres) = (column("artist"), column("song"), column("genres"))
    val (listeners, plays, loved) = (column("listeners"), column("plays"), column("loved_by"))
    // Optional: older copies of the file don't have these.
    val year = columns.indexOf("year")
    val youtubeId = columns.indexOf("youtube_id")
    val songId = columns.indexOf("id")
    val songs = rows.map: r =>
      Song(
        artist = r(artist).asInstanceOf[String],
        title = r(title).asInstanceOf[String],
        genres = r(genres).asInstanceOf[js.Array[String]].toVector,
        listeners = r(listeners).asInstanceOf[Int],
        plays = r(plays).asInstanceOf[Int],
        lovedBy = r(loved).asInstanceOf[Int],
        year = if year < 0 || r(year) == null then None else Some(r(year).asInstanceOf[Int]),
        youtubeId = if youtubeId < 0 || r(youtubeId) == null then None else Some(r(youtubeId).asInstanceOf[String]),
        id = if songId < 0 || r(songId) == null then None else Some(r(songId).asInstanceOf[Int])
      )
    songs.toVector

  def run(library: Library, q: Query, shuffleSeed: Int): Result =
    val artist = q.artist.trim.toLowerCase
    val title = q.title.trim.toLowerCase
    def inRange(v: Int, lo: Option[Int], hi: Option[Int]) = lo.forall(v >= _) && hi.forall(v <= _)
    val (loL, hiL) = (number(q.minListeners), number(q.maxListeners))
    val (loP, hiP) = (number(q.minPlays), number(q.maxPlays))
    val (loH, hiH) = (number(q.minLoved), number(q.maxLoved))
    val (loY, hiY) = (number(q.yearFrom), number(q.yearTo))
    val filteringByYear = loY.isDefined || hiY.isDefined
    // Sorted last either way: a song with no known year isn't the newest or the oldest.
    val noYear = (s: Song) => s.year.isEmpty

    val matched = library.songs.filter: s =>
      (q.genres.isEmpty ||
        (if q.matchAllGenres then q.genres.forall(s.genres.contains) else s.genres.exists(q.genres))) &&
      !s.genres.exists(q.excludedGenres) &&
      (artist.isEmpty || s.artistLower.contains(artist)) &&
      (title.isEmpty || s.titleLower.contains(title)) &&
      inRange(s.listeners, loL, hiL) && inRange(s.plays, loP, hiP) && inRange(s.lovedBy, loH, hiH) &&
      (!filteringByYear || s.year.exists(inRange(_, loY, hiY))) &&
      (!q.playableOnly || s.youtubeId.isDefined)

    // Ties fall back to artist and title, so a repeated query keeps the same order.
    val sorted = q.sort match
      case SortBy.MostListeners   => matched.sortBy(s => (-s.listeners, -s.plays, s.artistLower, s.titleLower))
      case SortBy.FewestListeners => matched.sortBy(s => (s.listeners, s.plays, s.artistLower, s.titleLower))
      case SortBy.MostPlays       => matched.sortBy(s => (-s.plays, -s.listeners, s.artistLower, s.titleLower))
      case SortBy.FewestPlays     => matched.sortBy(s => (s.plays, s.listeners, s.artistLower, s.titleLower))
      case SortBy.MostLoved       => matched.sortBy(s => (-s.lovedBy, -s.listeners, s.artistLower, s.titleLower))
      case SortBy.FewestLoved     => matched.sortBy(s => (s.lovedBy, s.listeners, s.artistLower, s.titleLower))
      case SortBy.Newest          => matched.sortBy(s => (noYear(s), -s.year.getOrElse(0), -s.listeners, s.artistLower, s.titleLower))
      case SortBy.Oldest          => matched.sortBy(s => (noYear(s), s.year.getOrElse(0), -s.listeners, s.artistLower, s.titleLower))
      case SortBy.ArtistAZ        => matched.sortBy(s => (s.artistLower, s.titleLower))
      case SortBy.TitleAZ         => matched.sortBy(s => (s.titleLower, s.artistLower))
      case SortBy.Shuffle         => new Random(shuffleSeed).shuffle(matched)

    Result(matched.size, sorted.take(q.limit))
