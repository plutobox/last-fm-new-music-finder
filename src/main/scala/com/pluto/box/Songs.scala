package com.pluto.box

import scala.scalajs.js

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

// A song the listeners of another song also listen to or love.
final case class SongMatch(song: Song, sharedListeners: Int)

object Songs:
  // data/similar/manifest.json: when the matches were built, and how many files they're split across.
  def parseMatchFiles(text: String): (String, Int) =
    val root = js.JSON.parse(text)
    (root.built_at.asInstanceOf[String], root.shards.asInstanceOf[Int])

  // One of the split match files, already best first: pairs of a song ID and the number of listeners in common.
  def parseMatches(text: String, id: Int): Vector[(Int, Int)] =
    val root = js.JSON.parse(text).asInstanceOf[js.Dictionary[js.Array[js.Array[Int]]]]
    root.get(id.toString).toVector.flatMap(_.toVector).map(pair => (pair(0), pair(1)))
