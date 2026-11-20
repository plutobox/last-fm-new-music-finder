package com.pluto.box

import scala.collection.mutable
import scala.concurrent.Future
import scala.scalajs.concurrent.JSExecutionContext.Implicits.queue
import scala.scalajs.js

// Thrown when a newer search replaces this one, so it stops reading.
final class Cancelled extends Exception("replaced by a newer search")

// Searches the song files without loading them all. Each row group's statistics say which values it holds, so a
// search skips groups that can't match, and reads the rest in the order most likely to give the best songs first.
// Once it has enough songs and no remaining group could beat the worst of them, it stops: the default "most
// listeners" view reads only the start of the first file.
//
// Only the columns a query filters or sorts by are read, cheapest first: the artist and song text, most of the data,
// is read for a group only when some of its rows pass every other test and could still make the list. Whole songs
// are read only for the ones shown.
object Search:
  private type Columns = Map[String, js.Array[js.Any]]

  private def number(s: String): Option[Int] = s.trim.toIntOption

  // What a query needs from each row group, and how to test a row: first on the cheap columns, then on the text.
  private final case class Plan(
    cheapColumns: Seq[String],
    textColumns: Seq[String],
    fileMayMatch: SongFile => Boolean,
    groupMayMatch: Group => Boolean,
    // True when the statistics alone prove every row in the group matches.
    groupAllMatch: Group => Boolean,
    keepCheap: (Columns, Int) => Boolean,
    keepText: (Columns, Int) => Boolean
  ):
    def filtered: Boolean = cheapColumns.nonEmpty || textColumns.nonEmpty
    // Counting these means reading every artist or song name, which is most of the data.
    def countIsCostly: Boolean = textColumns.nonEmpty

  private def overlaps(span: Option[Span], lo: Option[Int], hi: Option[Int]) =
    span.forall(s => lo.forall(_ <= s.max) && hi.forall(_ >= s.min))

  private def within(span: Option[Span], lo: Option[Int], hi: Option[Int]) =
    span.exists(s => lo.forall(s.min >= _) && hi.forall(s.max <= _))

  private def plan(q: Query): Plan =
    val artist = q.artist.trim.toLowerCase
    val title = q.title.trim.toLowerCase
    val ranges = Seq(
      ("listeners", number(q.minListeners), number(q.maxListeners)),
      ("plays", number(q.minPlays), number(q.maxPlays)),
      ("loved_by", number(q.minLoved), number(q.maxLoved))
    ).filter((_, lo, hi) => lo.isDefined || hi.isDefined)
    val (yearFrom, yearTo) = (number(q.yearFrom), number(q.yearTo))
    val byYear = yearFrom.isDefined || yearTo.isDefined
    val byGenre = q.genres.nonEmpty || q.excludedGenres.nonEmpty
    val (loL, hiL) = (number(q.minListeners), number(q.maxListeners))

    def inRange(v: Double, lo: Option[Int], hi: Option[Int]) = lo.forall(v >= _) && hi.forall(v <= _)

    Plan(
      cheapColumns = ranges.map(_._1) ++ Seq(
        Option.when(byYear)("year"),
        Option.when(q.playableOnly)("youtube_id"),
        Option.when(byGenre)("genres")
      ).flatten,
      textColumns = Seq(Option.when(artist.nonEmpty)("artist"), Option.when(title.nonEmpty)("song")).flatten,
      fileMayMatch = f => loL.forall(_ <= f.maxListeners) && hiL.forall(_ >= f.minListeners),
      groupMayMatch = g =>
        ranges.forall((name, lo, hi) => overlaps(g.span(name), lo, hi)) &&
          (!byYear || (!g.allNull("year") && overlaps(g.span("year"), yearFrom, yearTo))) &&
          (!q.playableOnly || !g.allNull("youtube_id")),
      groupAllMatch = g =>
        !byGenre && artist.isEmpty && title.isEmpty && !q.playableOnly &&
          ranges.forall((name, lo, hi) => within(g.span(name), lo, hi)) &&
          (!byYear || (g.noNulls("year") && within(g.span("year"), yearFrom, yearTo))),
      keepCheap = (c, i) =>
        ranges.forall((name, lo, hi) => inRange(SongStore.number(c(name)(i)), lo, hi)) &&
          (!byYear || {
            val y = c("year")(i)
            !SongStore.isMissing(y) && inRange(SongStore.number(y), yearFrom, yearTo)
          }) &&
          (!q.playableOnly || !SongStore.isMissing(c("youtube_id")(i))) &&
          (!byGenre || {
            val raw = c("genres")(i)
            val genres = if SongStore.isMissing(raw) then js.Array[String]() else raw.asInstanceOf[js.Array[String]]
            (q.genres.isEmpty ||
              (if q.matchAllGenres then q.genres.forall(genres.contains) else genres.exists(q.genres))) &&
            !genres.exists(q.excludedGenres)
          }),
      keepText = (c, i) =>
        (artist.isEmpty || c("artist")(i).asInstanceOf[String].toLowerCase.contains(artist)) &&
          (title.isEmpty || c("song")(i).asInstanceOf[String].toLowerCase.contains(title))
    )

  // A matching row's place in the order: compared by first, then second, then text, then position, all
  // ascending. Position (where the row sits in the files) breaks ties, so a repeated search keeps the same order.
  private final case class Candidate(group: Group, index: Int, first: Double, second: Double, text: String):
    def position: Double = group.position + index

  private given Ordering[Candidate] = (x, y) =>
    var c = java.lang.Double.compare(x.first, y.first)
    if c == 0 then c = java.lang.Double.compare(x.second, y.second)
    if c == 0 then c = x.text.compareTo(y.text)
    if c == 0 then c = java.lang.Double.compare(x.position, y.position)
    c

  // How to rank rows for a sort, and the best first value any row in a group or file could have, so the search can
  // read groups best first and stop when none left could make the list. A sort by text needs the text columns.
  private final case class Order(
    columns: Seq[String],
    key: (Group, Columns, Int) => Candidate,
    groupBound: Group => Double,
    fileBound: SongFile => Double
  ):
    def needsText: Boolean = columns.exists(SongStore.textColumns)

  private val Inf = Double.PositiveInfinity

  // Spreads row positions evenly over [0, 1) for a given seed, so a shuffle is random but repeatable.
  private def mix(position: Double, seed: Int): Double =
    var h = position.toInt ^ (seed * 0x9e3779b9)
    h = (h ^ (h >>> 16)) * 0x85ebca6b
    h = (h ^ (h >>> 13)) * 0xc2b2ae35
    h = h ^ (h >>> 16)
    (h >>> 1).toDouble / 2147483648.0

  private def order(sort: SortBy, seed: Int): Order =
    def num(c: Columns, name: String, i: Int) = SongStore.number(c(name)(i))
    def year(c: Columns, i: Int) = Option(c("year")(i)).filterNot(SongStore.isMissing).map(SongStore.number)
    def text(c: Columns, name: String, i: Int) = c(name)(i).asInstanceOf[String].toLowerCase
    def byNumbers(main: String, next: String, descending: Boolean) =
      val sign = if descending then -1.0 else 1.0
      Order(
        Seq(main, next),
        (g, c, i) => Candidate(g, i, sign * num(c, main, i), sign * num(c, next, i), ""),
        g => g.span(main).fold(-Inf)(s => if descending then -s.max else s.min),
        f =>
          if main != "listeners" then -Inf
          else if descending then -f.maxListeners
          else f.minListeners
      )
    // Songs with no known year go last either way, ordered by listeners.
    def byYear(newest: Boolean) =
      val sign = if newest then -1.0 else 1.0
      Order(
        Seq("year", "listeners"),
        (g, c, i) => Candidate(g, i, year(c, i).fold(Inf)(sign * _), -num(c, "listeners", i), ""),
        g =>
          if g.allNull("year") then Inf
          else g.span("year").fold(-Inf)(s => if newest then -s.max else s.min),
        _ => -Inf
      )
    // Only the one name is read, so this reads half as much. Songs with the same name keep the files' order, most
    // listeners first, so an artist's best-known songs come first.
    def byText(column: String) =
      Order(Seq(column), (g, c, i) => Candidate(g, i, 0, 0, text(c, column, i)), _ => -Inf, _ => -Inf)
    sort match
      case SortBy.MostListeners   => byNumbers("listeners", "plays", descending = true)
      case SortBy.FewestListeners => byNumbers("listeners", "plays", descending = false)
      case SortBy.MostPlays       => byNumbers("plays", "listeners", descending = true)
      case SortBy.FewestPlays     => byNumbers("plays", "listeners", descending = false)
      case SortBy.MostLoved       => byNumbers("loved_by", "listeners", descending = true)
      case SortBy.FewestLoved     => byNumbers("loved_by", "listeners", descending = false)
      case SortBy.Newest          => byYear(newest = true)
      case SortBy.Oldest          => byYear(newest = false)
      case SortBy.ArtistAZ        => byText("artist")
      case SortBy.TitleAZ         => byText("song")
      case SortBy.Shuffle =>
        Order(Seq.empty, (g, _, i) => Candidate(g, i, mix(g.position + i, seed), 0, ""), _ => -Inf, _ => -Inf)

  private def check(alive: () => Boolean): Unit = if !alive() then throw new Cancelled

  // The rows of one group that pass every test: the cheap columns first, then the text, read only for rows that are
  // left. worthText decides whether a row that passed the cheap tests is still worth reading the text for.
  private def matching(store: SongStore, p: Plan, g: Group, extra: Seq[String], worthText: (Columns, Int) => Boolean)
      : Future[(Columns, Seq[Int])] =
    val cheap = (p.cheapColumns ++ extra.filterNot(SongStore.textColumns)).distinct
    val text = (p.textColumns ++ extra.filter(SongStore.textColumns)).distinct
    val cheapRead = if cheap.isEmpty then Future.successful(Map.empty: Columns) else store.columns(g, cheap)
    cheapRead.flatMap: c =>
      val passed = (0 until g.rows).filter(i => p.keepCheap(c, i) && worthText(c, i))
      if text.isEmpty || passed.isEmpty then Future.successful((c, passed))
      else store.columns(g, text).map(t => (c ++ t, passed.filter(p.keepText(c ++ t, _))))

  // The songs to show for a query, best first. progress is told how many songs have been checked so far, and
  // alive() turning false stops the search with Cancelled.
  def top(store: SongStore, catalog: Catalog, q: Query, seed: Int, alive: () => Boolean, progress: Int => Unit)
      : Future[Vector[Song]] =
    val p = plan(q)
    val o = order(q.sort, seed)
    val ordering = summon[Ordering[Candidate]]

    // The best songs so far, in order, never more than the limit.
    val best = mutable.ArrayBuffer[Candidate]()
    def full = best.size >= q.limit
    def offer(c: Candidate): Unit =
      if !full || ordering.lt(c, best.last) then
        var lo = 0
        var hi = best.size
        while lo < hi do
          val mid = (lo + hi) / 2
          if ordering.lt(best(mid), c) then lo = mid + 1 else hi = mid
        best.insert(lo, c)
        if best.size > q.limit then best.remove(best.size - 1)
    def cannotBeat(g: Group) = full && o.groupBound(g) > best.last.first
    // With a numeric sort, a row that can't beat the worst song so far isn't worth reading the text for.
    def worthText(g: Group)(c: Columns, i: Int) = o.needsText || !full || ordering.lt(o.key(g, c, i), best.last)

    // Files are opened only once a group in them could come next, so a search that stops early never opens the rest.
    var pending = catalog.files.filter(p.fileMayMatch).sortBy(o.fileBound).toList
    val waiting = mutable.ArrayBuffer[Group]()
    var checked = 0

    def openReady(): Future[Unit] =
      val threshold = waiting.headOption.map(o.groupBound).orElse(pending.headOption.map(o.fileBound))
      val ready = threshold.fold(List.empty[SongFile])(t => pending.takeWhile(f => o.fileBound(f) <= t))
      if ready.isEmpty then Future.unit
      else
        pending = pending.drop(ready.size)
        Future.traverse(ready)(store.open).flatMap: files =>
          check(alive)
          waiting ++= files.flatMap(_.groups.filter(p.groupMayMatch))
          waiting.sortInPlaceBy(o.groupBound)
          openReady()

    // Reads a few groups at a time, more once it's clear the search won't stop soon.
    def step(batch: Int): Future[Unit] =
      check(alive)
      openReady().flatMap: _ =>
        if waiting.isEmpty || cannotBeat(waiting.head) then Future.unit
        else
          val limit = pending.headOption.fold(Inf)(o.fileBound)
          val next = waiting.iterator.takeWhile(g => o.groupBound(g) <= limit).take(batch).toVector
          waiting.remove(0, next.size)
          Future
            .traverse(next.filterNot(cannotBeat))(g => matching(store, p, g, o.columns, worthText(g)).map(g -> _))
            .flatMap: read =>
              check(alive)
              for (g, (c, rows)) <- read; i <- rows do offer(o.key(g, c, i))
              checked += next.map(_.rows).sum
              progress(checked)
              step((batch * 2).min(8))

    step(1).flatMap: _ =>
      val byGroup = best.groupBy(_.group).toVector
      Future
        .traverse(byGroup)((g, cs) => store.songs(g, cs.map(_.index).toSeq).map(g -> _))
        .map: read =>
          check(alive)
          val songs = read.toMap
          best.toVector.map(c => songs(c.group)(c.index))

  // Whether counting a query's matches means reading every artist or song name.
  def countIsCostly(q: Query): Boolean = plan(q).countIsCostly

  // How many songs match. Without filters the manifest already says; groups whose statistics prove every row
  // matches are counted without being read.
  def count(store: SongStore, catalog: Catalog, q: Query, alive: () => Boolean, progress: Int => Unit): Future[Int] =
    val p = plan(q)
    if !p.filtered then Future.successful(catalog.count)
    else
      Future.traverse(catalog.files.filter(p.fileMayMatch))(store.open).flatMap: files =>
        val groups = files.flatMap(_.groups.filter(p.groupMayMatch))
        var checked = 0
        def go(rest: Vector[Group], total: Int): Future[Int] =
          check(alive)
          if rest.isEmpty then Future.successful(total)
          else
            val (now, later) = rest.splitAt(6)
            Future
              .traverse(now): g =>
                if p.groupAllMatch(g) then Future.successful(g.rows)
                else matching(store, p, g, Seq.empty, (_, _) => true).map(_._2.size)
              .flatMap: counts =>
                checked += now.map(_.rows).sum
                progress(checked)
                go(later, total + counts.sum)
        go(groups, 0)

  // Songs by ID, for the "Like this song?" matches. A match shares at least 3 listeners with the song, so it has at
  // least 3 itself, and matches are usually well known, so the files with the most listeners are searched first.
  def byIds(store: SongStore, catalog: Catalog, ids: Seq[Int]): Future[Map[Int, Song]] =
    val remaining = mutable.Set.from(ids)
    val found = mutable.ArrayBuffer[(Group, Int, Int)]()
    val files = catalog.files.filter(_.maxListeners >= 3).sortBy(-_.maxListeners).toList
    def groups(rest: Vector[Group]): Future[Unit] =
      if rest.isEmpty || remaining.isEmpty then Future.unit
      else
        val (now, later) = rest.splitAt(4)
        val useful = now.filter(g => g.span("id").forall(s => remaining.exists(id => id >= s.min && id <= s.max)))
        Future
          .traverse(useful)(g => store.columns(g, Seq("id")).map(g -> _("id")))
          .flatMap: read =>
            for (g, values) <- read; i <- 0 until g.rows do
              val id = SongStore.number(values(i)).toInt
              if remaining.remove(id) then found += ((g, i, id))
            groups(later)
    def go(rest: List[SongFile]): Future[Unit] = rest match
      case f :: more if remaining.nonEmpty => store.open(f).flatMap(file => groups(file.groups)).flatMap(_ => go(more))
      case _ => Future.unit
    go(files).flatMap: _ =>
      Future
        .traverse(found.groupBy(_._1).toVector): (g, rows) =>
          store.songs(g, rows.map(_._2).toSeq).map(songs => rows.map((_, i, id) => id -> songs(i)))
        .map(_.flatten.toMap)
