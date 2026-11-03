ThisBuild / scalaVersion := "3.3.4"

lazy val root = (project in file("."))
  .enablePlugins(ScalaJSPlugin)
  .settings(
    name := "last-fm-new-music-finder",
    scalaJSUseMainModuleInitializer := true,
    scalaJSLinkerConfig ~= (_.withModuleKind(ModuleKind.NoModule)),
    libraryDependencies += "com.raquo" %%% "laminar" % "17.2.0"
  )
