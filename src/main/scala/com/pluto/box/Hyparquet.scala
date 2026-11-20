package com.pluto.box

import scala.scalajs.js
import scala.scalajs.js.annotation.JSGlobal

// Facade for the parts of hyparquet (https://github.com/hyparam/hyparquet) the song search uses. index.html imports
// the library as a module and puts it on window.hyparquet before it loads main.js.
@js.native
@JSGlobal("hyparquet")
object Hyparquet extends js.Object:
  // Reads a file over HTTP range requests. With byteLength given, it skips the HEAD request to find the size.
  def asyncBufferFromUrl(options: UrlOptions): js.Promise[AsyncBuffer] = js.native
  def parquetMetadataAsync(file: AsyncBuffer, options: MetadataOptions): js.Promise[FileMetaData] = js.native
  // Calls onChunk once per column per row group with the decoded values, without building an object per row.
  def parquetRead(options: ReadOptions): js.Promise[Unit] = js.native
  def parquetReadObjects(options: ReadOptions): js.Promise[js.Array[js.Dictionary[js.Any]]] = js.native

@js.native
trait AsyncBuffer extends js.Object

trait UrlOptions extends js.Object:
  val url: String
  val byteLength: Double

trait MetadataOptions extends js.Object:
  val initialFetchSize: Int

trait ReadOptions extends js.Object:
  val file: AsyncBuffer
  val metadata: FileMetaData
  val columns: js.Array[String]
  val rowStart: Double
  val rowEnd: Double
  val onChunk: js.UndefOr[js.Function1[ColumnChunkData, Unit]] = js.undefined

@js.native
trait ColumnChunkData extends js.Object:
  val columnName: String = js.native
  val columnData: js.Array[js.Any] = js.native
  val rowStart: Double = js.native
  val rowEnd: Double = js.native

@js.native
trait FileMetaData extends js.Object:
  val row_groups: js.Array[RowGroupMeta] = js.native

@js.native
trait RowGroupMeta extends js.Object:
  val num_rows: js.BigInt = js.native
  val columns: js.Array[ColumnChunkMeta] = js.native

@js.native
trait ColumnChunkMeta extends js.Object:
  val meta_data: js.UndefOr[ColumnMeta] = js.native

@js.native
trait ColumnMeta extends js.Object:
  val path_in_schema: js.Array[String] = js.native
  val statistics: js.UndefOr[ColumnStatistics] = js.native

// Values come already converted to their column's type, so a numeric column's are numbers.
@js.native
trait ColumnStatistics extends js.Object:
  val min_value: js.UndefOr[js.Any] = js.native
  val max_value: js.UndefOr[js.Any] = js.native
  val null_count: js.UndefOr[js.BigInt] = js.native
