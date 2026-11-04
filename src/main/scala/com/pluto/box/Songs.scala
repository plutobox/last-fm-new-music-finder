package com.pluto.box

import scala.scalajs.js
import scala.util.Random

final case class Song(
  artist: String,
  title: String,
  genres: Vector[String],
  listeners: Int,
  plays: Int,
  lovedBy: Int
):
  val artistLower: String = artist.toLowerCase
  val titleLower: String = title.toLowerCase

  // Last.fm's own URL style: spaces become "+", everything else percent-encoded.
  def url: String =
    def part(s: String) = js.URIUtils.encodeURIComponent(s).replace("%20", "+")
    s"https://www.last.fm/music/${part(artist)}/_/${part(title)}"

enum SortBy(val key: String, val label: String):
  case MostListeners extends SortBy("listeners-desc", "Most listeners")
  case FewestListeners extends SortBy("listeners-asc", "Fewest listeners")
  case MostPlays extends SortBy("plays-desc", "Most plays")
  case FewestPlays extends SortBy("plays-asc", "Fewest plays")
  case MostLoved extends SortBy("loved-desc", "Most loved")
  case FewestLoved extends SortBy("loved-asc", "Fewest loved")
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
  limit: Int = 10
)

final case class Library(songs: Vector[Song], builtAt: String):
  val maxListeners: Int = songs.iterator.map(_.listeners).maxOption.getOrElse(1)
  // Every genre with its song count, biggest first.
  val genres: Vector[(String, Int)] =
    songs.flatMap(_.genres).groupMapReduce(identity)(_ => 1)(_ + _).toVector.sortBy((g, n) => (-n, g))

final case class Result(matched: Int, songs: Vector[Song])

object Songs:
  private def number(s: String): Option[Int] = s.trim.toIntOption

  // Reads the columns by name, so adding a column to songs.json can't shift these.
  def parse(text: String): Library =
    val root = js.JSON.parse(text)
    val columns = root.columns.asInstanceOf[js.Array[String]]
    def column(name: String): Int =
      val i = columns.indexOf(name)
      if i < 0 then throw new Exception(s"songs.json has no \"$name\" column")
      i
    val (artist, title, genres) = (column("artist"), column("song"), column("genres"))
    val (listeners, plays, loved) = (column("listeners"), column("plays"), column("loved_by"))
    val rows = root.rows.asInstanceOf[js.Array[js.Array[js.Any]]]
    val songs = rows.iterator.map: r =>
      Song(
        artist = r(artist).asInstanceOf[String],
        title = r(title).asInstanceOf[String],
        genres = r(genres).asInstanceOf[js.Array[String]].toVector,
        listeners = r(listeners).asInstanceOf[Int],
        plays = r(plays).asInstanceOf[Int],
        lovedBy = r(loved).asInstanceOf[Int]
      )
    Library(songs.toVector, root.built_at.asInstanceOf[String])

  def run(library: Library, q: Query, shuffleSeed: Int): Result =
    val artist = q.artist.trim.toLowerCase
    val title = q.title.trim.toLowerCase
    def inRange(v: Int, lo: Option[Int], hi: Option[Int]) = lo.forall(v >= _) && hi.forall(v <= _)
    val (loL, hiL) = (number(q.minListeners), number(q.maxListeners))
    val (loP, hiP) = (number(q.minPlays), number(q.maxPlays))
    val (loH, hiH) = (number(q.minLoved), number(q.maxLoved))

    val matched = library.songs.filter: s =>
      (q.genres.isEmpty ||
        (if q.matchAllGenres then q.genres.forall(s.genres.contains) else s.genres.exists(q.genres))) &&
      !s.genres.exists(q.excludedGenres) &&
      (artist.isEmpty || s.artistLower.contains(artist)) &&
      (title.isEmpty || s.titleLower.contains(title)) &&
      inRange(s.listeners, loL, hiL) && inRange(s.plays, loP, hiP) && inRange(s.lovedBy, loH, hiH)

    // Ties fall back to artist and title, so a repeated query keeps the same order.
    val sorted = q.sort match
      case SortBy.MostListeners   => matched.sortBy(s => (-s.listeners, -s.plays, s.artistLower, s.titleLower))
      case SortBy.FewestListeners => matched.sortBy(s => (s.listeners, s.plays, s.artistLower, s.titleLower))
      case SortBy.MostPlays       => matched.sortBy(s => (-s.plays, -s.listeners, s.artistLower, s.titleLower))
      case SortBy.FewestPlays     => matched.sortBy(s => (s.plays, s.listeners, s.artistLower, s.titleLower))
      case SortBy.MostLoved       => matched.sortBy(s => (-s.lovedBy, -s.listeners, s.artistLower, s.titleLower))
      case SortBy.FewestLoved     => matched.sortBy(s => (s.lovedBy, s.listeners, s.artistLower, s.titleLower))
      case SortBy.ArtistAZ        => matched.sortBy(s => (s.artistLower, s.titleLower))
      case SortBy.TitleAZ         => matched.sortBy(s => (s.titleLower, s.artistLower))
      case SortBy.Shuffle         => new Random(shuffleSeed).shuffle(matched)

    Result(matched.size, sorted.take(q.limit))
