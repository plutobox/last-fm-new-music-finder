package com.pluto.box

import com.raquo.laminar.api.L.*
import org.scalajs.dom

import scala.scalajs.js
import scala.util.Try

// The player bar along the bottom of the page, plus YouTube's own player above it.
// YouTube requires its player to stay visible at 200x200 or larger, so "smaller" stops there and there's no audio-only mode.
final class Player:
  private val playerElementId = "youtube-player"
  private var yt: Option[js.Dynamic] = None

  val current = Var[Option[Song]](None)
  private val queue = Var(Vector.empty[Song])
  private val playing = Var(false)
  private val position = Var(0.0)
  private val duration = Var(0.0)
  private val volume = Var(100)
  private val largeVideo = Var(true)
  private val problem = Var[Option[String]](None)
  private val skipDelayMs = 2500

  // Videos that failed to play, remembered in this browser so they aren't tried again.
  val unplayable = Var(Player.loadUnplayable())

  def play(song: Song, upNext: Vector[Song]): Unit =
    queue.set(upNext)
    start(song)

  private def start(song: Song): Unit =
    song.youtubeId.foreach: id =>
      current.set(Some(song))
      problem.set(None)
      position.set(0)
      duration.set(0)
      yt match
        case Some(player) => player.loadVideoById(id)
        case None         => create(id)

  // Moves through the results the song was started from, past any video known not to play.
  private def step(by: Int): Unit =
    val q = queue.now()
    val bad = unplayable.now()
    current.now().map(q.indexOf).filter(_ >= 0).foreach: i =>
      Iterator.iterate(i + by)(_ + by)
        .takeWhile(q.indices.contains)
        .map(q)
        .find(_.youtubeId.forall(id => !bad.contains(id)))
        .foreach(start)

  private def create(id: String): Unit =
    Player.whenApiReady: () =>
      val options = js.Dynamic.literal(
        videoId = id,
        width = "100%",
        height = "100%",
        playerVars = js.Dynamic.literal(playsinline = 1, autoplay = 1, origin = dom.window.location.origin),
        events = js.Dynamic.literal(
          onStateChange = ((e: js.Dynamic) => onState(e.data.asInstanceOf[Int])): js.Function1[js.Dynamic, Unit],
          onError = ((e: js.Dynamic) => onError(e.data.asInstanceOf[Int])): js.Function1[js.Dynamic, Unit]
        )
      )
      val api = dom.window.asInstanceOf[js.Dynamic].YT
      yt = Some(js.Dynamic.newInstance(api.Player)(playerElementId, options))

  private def onState(state: Int): Unit = state match
    case 0 => playing.set(false); step(1) // ended
    case 1 => playing.set(true); problem.set(None)
    case 2 => playing.set(false)
    case _ => ()

  private def onError(code: Int): Unit =
    playing.set(false)
    val failed = current.now()
    problem.set(Some(code match
      case 101 | 150 => "This video's owner doesn't allow playing it here. Skipping."
      case 100       => "This video has been removed or made private. Skipping."
      case _         => "This video can't play here. Skipping."
    ))
    // These won't change on a retry. Other codes might be temporary, so they aren't remembered.
    if code == 100 || code == 101 || code == 150 then
      failed.flatMap(_.youtubeId).foreach: id =>
        unplayable.update(_ + id)
        Player.saveUnplayable(unplayable.now())
    // Only if nothing else has been started in the meantime.
    dom.window.setTimeout(() => if current.now() == failed && problem.now().isDefined then step(1), skipDelayMs)

  private def sample(): Unit =
    for player <- yt if playing.now() do
      position.set(player.getCurrentTime().asInstanceOf[Double])
      duration.set(player.getDuration().asInstanceOf[Double])

  private def togglePlaying(): Unit =
    yt.foreach(p => if playing.now() then p.pauseVideo() else p.playVideo())

  private def close(): Unit =
    yt.foreach(_.stopVideo())
    playing.set(false)
    current.set(None)

  private def clock(seconds: Double): String =
    val s = seconds.toInt.max(0)
    f"${s / 60}%d:${s % 60}%02d"

  val element: HtmlElement = div(
    cls := "player",
    cls("is-open") <-- current.signal.map(_.isDefined),
    onMountCallback(_ => dom.window.setInterval(() => sample(), 500)),
    div(
      cls := "player-video",
      cls("is-small") <-- largeVideo.signal.map(!_),
      div(idAttr := playerElementId)
    ),
    div(
      cls := "player-bar",
      aria.label := "Player",
      role := "region",
      input(
        cls := "player-seek",
        typ := "range",
        minAttr := "0",
        stepAttr := "1",
        aria.label := "Position in the song",
        maxAttr <-- duration.signal.map(_.max(1).toString),
        value <-- position.signal.map(_.toString),
        onInput.mapToValue --> { v =>
          position.set(v.toDouble)
          yt.foreach(_.seekTo(v.toDouble, true))
        }
      ),
      div(
        cls := "player-controls",
        iconButton("Previous song", "⏮︎", () => step(-1)),
        button(
          typ := "button",
          cls := "player-main",
          aria.label <-- playing.signal.map(p => if p then "Pause" else "Play"),
          child.text <-- playing.signal.map(p => if p then "⏸︎" else "▶︎"),
          onClick --> (_ => togglePlaying())
        ),
        iconButton("Next song", "⏭︎", () => step(1)),
        span(
          cls := "player-time",
          child.text <-- position.signal.combineWith(duration.signal).map((p, d) => s"${clock(p)} / ${clock(d)}")
        )
      ),
      div(
        cls := "player-song",
        child.maybe <-- current.signal.map(_.map: s =>
          div(
            div(cls := "player-title", s.title),
            div(cls := "player-artist", s.year.fold(s.artist)(y => s"${s.artist}, $y"))
          )
        ),
        child.maybe <-- problem.signal.combineWith(current.signal).map: (p, c) =>
          p.zip(c).map: (message, s) =>
            div(cls := "player-problem", message, " ", a(href := s.youtubeSearchUrl, target := "_blank", rel := "noopener", "Open on YouTube"))
      ),
      div(
        cls := "player-extras",
        input(
          cls := "player-volume",
          typ := "range",
          minAttr := "0",
          maxAttr := "100",
          aria.label := "Volume",
          value <-- volume.signal.map(_.toString),
          onInput.mapToValue --> { v =>
            volume.set(v.toInt)
            yt.foreach(_.setVolume(v.toInt))
          }
        ),
        button(
          typ := "button",
          cls := "player-text",
          child.text <-- largeVideo.signal.map(l => if l then "Smaller video" else "Larger video"),
          onClick --> (_ => largeVideo.update(!_))
        ),
        iconButton("Close player", "✕︎", () => close())
      )
    )
  )

  private def iconButton(name: String, icon: String, action: () => Unit) =
    button(typ := "button", cls := "player-icon", aria.label := name, icon, onClick --> (_ => action()))

object Player:
  private var waiting = Vector.empty[() => Unit]
  private val unplayableKey = "song-finder-unplayable-videos"

  // Storage can be blocked or empty, for example in a private window. The page works fine without it.
  private def loadUnplayable(): Set[String] =
    Try(js.JSON.parse(dom.window.localStorage.getItem(unplayableKey)).asInstanceOf[js.Array[String]].toSet)
      .toOption
      .filter(_ != null)
      .getOrElse(Set.empty)

  private def saveUnplayable(ids: Set[String]): Unit =
    Try(dom.window.localStorage.setItem(unplayableKey, js.JSON.stringify(js.Array(ids.toSeq*))))

  // YouTube's script calls a global function when it's ready, and it's only ever loaded once.
  private def whenApiReady(run: () => Unit): Unit =
    // Through window: assigning to a global name that doesn't exist yet throws in strict mode.
    val window = dom.window.asInstanceOf[js.Dynamic]
    if js.typeOf(window.YT) != "undefined" && js.typeOf(window.YT.Player) != "undefined" then run()
    else
      waiting = waiting :+ run
      if dom.document.getElementById("youtube-iframe-api") == null then
        val onReady: js.Function0[Unit] = () => {
          val ready = waiting
          waiting = Vector.empty
          ready.foreach(_())
        }
        window.updateDynamic("onYouTubeIframeAPIReady")(onReady)
        val tag = dom.document.createElement("script").asInstanceOf[dom.html.Script]
        tag.id = "youtube-iframe-api"
        tag.src = "https://www.youtube.com/iframe_api"
        dom.document.head.appendChild(tag)
