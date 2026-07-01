"use client"

import * as React from "react"
import {
  ArrowUpRight,
  Download,
  Eraser,
  Highlighter,
  Minus,
  PenLine,
  Plus,
  Redo2,
  Save,
  Square as SquareIcon,
  Trash2,
  Type,
  Undo2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type AnnotationTool = "pen" | "highlighter" | "eraser" | "arrow" | "rectangle" | "text"

interface Point {
  x: number
  y: number
  pressure: number
}

interface PathMark {
  kind: "path"
  tool: "pen" | "highlighter" | "eraser"
  color: string
  size: number
  points: Point[]
}

interface ShapeMark {
  kind: "shape"
  shape: "arrow" | "rectangle"
  color: string
  size: number
  start: Point
  end: Point
}

interface TextMark {
  kind: "text"
  color: string
  size: number
  point: Point
  text: string
}

type AnnotationMark = PathMark | ShapeMark | TextMark

interface ImageAnnotationEditorProps {
  imageUrl: string
  filename: string
  onSave?: (file: File) => void | Promise<void>
}

const COLORS = ["#f43f5e", "#f97316", "#facc15", "#22c55e", "#38bdf8", "#a855f7", "#ffffff", "#111827"]
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3

function annotatedFilename(filename: string) {
  const clean = filename.trim() || "image"
  const withoutExt = clean.replace(/\.[^./\\]+$/, "")
  return `${withoutExt || "image"}-annotated.png`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function drawArrowHead(ctx: CanvasRenderingContext2D, start: Point, end: Point, size: number) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const length = Math.max(size * 4, 14)
  const spread = Math.PI / 7
  ctx.beginPath()
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(end.x - length * Math.cos(angle - spread), end.y - length * Math.sin(angle - spread))
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(end.x - length * Math.cos(angle + spread), end.y - length * Math.sin(angle + spread))
  ctx.stroke()
}

function drawPathMark(ctx: CanvasRenderingContext2D, mark: PathMark) {
  if (mark.points.length === 0) return

  ctx.save()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.strokeStyle = mark.color
  ctx.globalAlpha = mark.tool === "highlighter" ? 0.42 : 1
  if (mark.tool === "highlighter") ctx.globalCompositeOperation = "multiply"
  if (mark.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out"
    ctx.strokeStyle = "rgba(0,0,0,1)"
  }

  if (mark.points.length === 1) {
    const point = mark.points[0]
    ctx.beginPath()
    ctx.arc(point.x, point.y, mark.size / 2, 0, Math.PI * 2)
    ctx.fillStyle = mark.tool === "eraser" ? "rgba(0,0,0,1)" : mark.color
    ctx.fill()
    ctx.restore()
    return
  }

  for (let i = 1; i < mark.points.length; i += 1) {
    const prev = mark.points[i - 1]
    const next = mark.points[i]
    const pressure = mark.tool === "eraser" ? 1 : (prev.pressure + next.pressure) / 2
    ctx.lineWidth = Math.max(1, mark.size * clamp(pressure, 0.25, 1.8))
    ctx.beginPath()
    ctx.moveTo(prev.x, prev.y)
    ctx.lineTo(next.x, next.y)
    ctx.stroke()
  }
  ctx.restore()
}

function drawShapeMark(ctx: CanvasRenderingContext2D, mark: ShapeMark) {
  ctx.save()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.strokeStyle = mark.color
  ctx.lineWidth = mark.size
  if (mark.shape === "rectangle") {
    const x = Math.min(mark.start.x, mark.end.x)
    const y = Math.min(mark.start.y, mark.end.y)
    const width = Math.abs(mark.end.x - mark.start.x)
    const height = Math.abs(mark.end.y - mark.start.y)
    ctx.strokeRect(x, y, width, height)
  } else {
    ctx.beginPath()
    ctx.moveTo(mark.start.x, mark.start.y)
    ctx.lineTo(mark.end.x, mark.end.y)
    ctx.stroke()
    drawArrowHead(ctx, mark.start, mark.end, mark.size)
  }
  ctx.restore()
}

function drawTextMark(ctx: CanvasRenderingContext2D, mark: TextMark) {
  ctx.save()
  ctx.font = `600 ${mark.size}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  ctx.lineJoin = "round"
  ctx.miterLimit = 2
  ctx.strokeStyle = "rgba(0,0,0,0.58)"
  ctx.lineWidth = Math.max(3, mark.size * 0.14)
  ctx.strokeText(mark.text, mark.point.x, mark.point.y)
  ctx.fillStyle = mark.color
  ctx.fillText(mark.text, mark.point.x, mark.point.y)
  ctx.restore()
}

function drawMark(ctx: CanvasRenderingContext2D, mark: AnnotationMark) {
  if (mark.kind === "path") drawPathMark(ctx, mark)
  else if (mark.kind === "shape") drawShapeMark(ctx, mark)
  else drawTextMark(ctx, mark)
}

function toolLabel(tool: AnnotationTool) {
  switch (tool) {
    case "pen":
      return "Pen"
    case "highlighter":
      return "Highlighter"
    case "eraser":
      return "Eraser"
    case "arrow":
      return "Arrow"
    case "rectangle":
      return "Rectangle"
    case "text":
      return "Text"
  }
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "text-white/72 hover:bg-white/12 hover:text-white",
            active && "bg-white text-black hover:bg-white hover:text-black"
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function SwatchButton({
  color,
  active,
  onClick,
}: {
  color: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Color ${color}`}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "grid size-6 place-items-center rounded-full border border-white/18 transition",
            active ? "scale-110 ring-2 ring-white" : "hover:scale-105 hover:ring-1 hover:ring-white/65"
          )}
        >
          <span
            className="size-4 rounded-full border border-black/20"
            style={{ backgroundColor: color }}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Color</TooltipContent>
    </Tooltip>
  )
}

export function ImageAnnotationEditor({ imageUrl, filename, onSave }: ImageAnnotationEditorProps) {
  const imageRef = React.useRef<HTMLImageElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const activePointerIdRef = React.useRef<number | null>(null)
  const liveMarkRef = React.useRef<AnnotationMark | null>(null)
  const marksRef = React.useRef<AnnotationMark[]>([])

  const [imageSize, setImageSize] = React.useState({ width: 0, height: 0 })
  const [viewportSize, setViewportSize] = React.useState({ width: 0, height: 0 })
  const [marks, setMarks] = React.useState<AnnotationMark[]>([])
  const [redoStack, setRedoStack] = React.useState<AnnotationMark[]>([])
  const [tool, setTool] = React.useState<AnnotationTool>("pen")
  const [color, setColor] = React.useState(COLORS[0])
  const [strokeSize, setStrokeSize] = React.useState(8)
  const [zoom, setZoom] = React.useState(1)
  const [textValue, setTextValue] = React.useState("Note")
  const [saveState, setSaveState] = React.useState<"idle" | "saving" | "saved" | "error">("idle")
  const [exportError, setExportError] = React.useState<string | null>(null)

  const drawAll = React.useCallback((liveMark: AnnotationMark | null = liveMarkRef.current) => {
    const canvas = canvasRef.current
    if (!canvas || imageSize.width <= 0 || imageSize.height <= 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const mark of marksRef.current) drawMark(ctx, mark)
    if (liveMark) drawMark(ctx, liveMark)
  }, [imageSize.height, imageSize.width])

  React.useEffect(() => {
    marksRef.current = marks
    drawAll()
  }, [drawAll, marks])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || imageSize.width <= 0 || imageSize.height <= 0) return
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    drawAll()
  }, [drawAll, imageSize.height, imageSize.width])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const update = () => {
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      })
    }
    update()

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update)
      return () => window.removeEventListener("resize", update)
    }

    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable='true']")) return
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key !== "z" && key !== "y") return
      event.preventDefault()
      if (key === "z" && !event.shiftKey) {
        setMarks(prev => {
          const next = prev.slice(0, -1)
          const undone = prev.at(-1)
          if (undone) setRedoStack(stack => [...stack, undone])
          return next
        })
      } else {
        setRedoStack(prev => {
          const restored = prev.at(-1)
          if (restored) setMarks(current => [...current, restored])
          return prev.slice(0, -1)
        })
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  const fitScale = React.useMemo(() => {
    if (imageSize.width <= 0 || imageSize.height <= 0 || viewportSize.width <= 0 || viewportSize.height <= 0) return 1
    const availableWidth = Math.max(1, viewportSize.width - 24)
    const availableHeight = Math.max(1, viewportSize.height - 24)
    return Math.min(availableWidth / imageSize.width, availableHeight / imageSize.height, 1)
  }, [imageSize.height, imageSize.width, viewportSize.height, viewportSize.width])
  const displayScale = fitScale * zoom
  const displayWidth = imageSize.width > 0 ? Math.max(1, imageSize.width * displayScale) : undefined
  const displayHeight = imageSize.height > 0 ? Math.max(1, imageSize.height * displayScale) : undefined
  const canUndo = marks.length > 0
  const canRedo = redoStack.length > 0
  const hasMarks = marks.length > 0

  const pointFromEvent = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current
    if (!canvas || imageSize.width <= 0 || imageSize.height <= 0) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * imageSize.width, 0, imageSize.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * imageSize.height, 0, imageSize.height),
      pressure: event.pressure > 0 ? event.pressure : 0.75,
    }
  }, [imageSize.height, imageSize.width])

  const screenToImageScale = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || imageSize.width <= 0) return 1
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0) return 1
    return imageSize.width / rect.width
  }, [imageSize.width])

  const commitMark = React.useCallback((mark: AnnotationMark) => {
    setSaveState("idle")
    setExportError(null)
    setRedoStack([])
    setMarks(prev => {
      const next = [...prev, mark]
      marksRef.current = next
      return next
    })
  }, [])

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return
    const point = pointFromEvent(event)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    const scaledSize = strokeSize * screenToImageScale()
    if (tool === "text") {
      const text = textValue.trim()
      if (!text) return
      commitMark({
        kind: "text",
        color,
        point,
        size: Math.max(14, scaledSize * 2.4),
        text,
      })
      return
    }

    activePointerIdRef.current = event.pointerId
    if (tool === "arrow" || tool === "rectangle") {
      liveMarkRef.current = {
        kind: "shape",
        shape: tool,
        color,
        size: Math.max(2, scaledSize),
        start: point,
        end: point,
      }
    } else {
      liveMarkRef.current = {
        kind: "path",
        tool,
        color,
        size: Math.max(2, tool === "eraser" ? scaledSize * 2.2 : scaledSize),
        points: [point],
      }
    }
    drawAll()
  }, [color, commitMark, drawAll, pointFromEvent, screenToImageScale, strokeSize, textValue, tool])

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return
    const point = pointFromEvent(event)
    const mark = liveMarkRef.current
    if (!point || !mark) return
    event.preventDefault()
    if (mark.kind === "path") {
      const last = mark.points.at(-1)
      if (!last || distance(last, point) >= Math.max(1, mark.size * 0.18)) {
        mark.points.push(point)
      }
    } else if (mark.kind === "shape") {
      mark.end = point
    }
    drawAll(mark)
  }, [drawAll, pointFromEvent])

  const finishPointer = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return
    const mark = liveMarkRef.current
    activePointerIdRef.current = null
    liveMarkRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The browser can release capture automatically when the pointer leaves.
    }

    if (!mark) {
      drawAll(null)
      return
    }
    if (mark.kind === "path" && mark.points.length < 2) {
      drawAll(null)
      return
    }
    if (mark.kind === "shape" && distance(mark.start, mark.end) < mark.size * 1.5) {
      drawAll(null)
      return
    }
    commitMark(mark)
  }, [commitMark, drawAll])

  const undo = React.useCallback(() => {
    setMarks(prev => {
      const undone = prev.at(-1)
      if (undone) setRedoStack(stack => [...stack, undone])
      const next = prev.slice(0, -1)
      marksRef.current = next
      return next
    })
    setSaveState("idle")
  }, [])

  const redo = React.useCallback(() => {
    setRedoStack(prev => {
      const restored = prev.at(-1)
      if (restored) {
        setMarks(current => {
          const next = [...current, restored]
          marksRef.current = next
          return next
        })
      }
      return prev.slice(0, -1)
    })
    setSaveState("idle")
  }, [])

  const clear = React.useCallback(() => {
    marksRef.current = []
    setMarks([])
    setRedoStack([])
    setSaveState("idle")
    setExportError(null)
    liveMarkRef.current = null
    drawAll(null)
  }, [drawAll])

  const zoomBy = React.useCallback((delta: number) => {
    setZoom(value => clamp(Number((value + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM))
  }, [])

  const buildAnnotatedBlob = React.useCallback(async () => {
    const image = imageRef.current
    if (!image || imageSize.width <= 0 || imageSize.height <= 0) {
      throw new Error("Image is not ready yet.")
    }

    const output = document.createElement("canvas")
    output.width = imageSize.width
    output.height = imageSize.height
    const ctx = output.getContext("2d")
    if (!ctx) throw new Error("Canvas is not available.")
    ctx.drawImage(image, 0, 0, imageSize.width, imageSize.height)

    const overlay = document.createElement("canvas")
    overlay.width = imageSize.width
    overlay.height = imageSize.height
    const overlayCtx = overlay.getContext("2d")
    if (!overlayCtx) throw new Error("Canvas is not available.")
    for (const mark of marksRef.current) drawMark(overlayCtx, mark)
    ctx.drawImage(overlay, 0, 0)

    const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, "image/png", 0.95))
    if (!blob) throw new Error("Could not export the annotated image.")
    return blob
  }, [imageSize.height, imageSize.width])

  const handleDownload = React.useCallback(async () => {
    try {
      setExportError(null)
      const blob = await buildAnnotatedBlob()
      downloadBlob(blob, annotatedFilename(filename))
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Could not export this image.")
    }
  }, [buildAnnotatedBlob, filename])

  const handleSave = React.useCallback(async () => {
    if (!onSave) return
    try {
      setSaveState("saving")
      setExportError(null)
      const blob = await buildAnnotatedBlob()
      const file = new File([blob], annotatedFilename(filename), { type: "image/png" })
      await onSave(file)
      setSaveState("saved")
    } catch (error) {
      setSaveState("error")
      setExportError(error instanceof Error ? error.message : "Could not save this image.")
    }
  }, [buildAnnotatedBlob, filename, onSave])

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-white/10 bg-black/35 px-2.5 py-2 backdrop-blur-md">
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] p-1">
            <ToolButton label={toolLabel("pen")} active={tool === "pen"} onClick={() => setTool("pen")}>
              <PenLine className="size-4" />
            </ToolButton>
            <ToolButton label={toolLabel("highlighter")} active={tool === "highlighter"} onClick={() => setTool("highlighter")}>
              <Highlighter className="size-4" />
            </ToolButton>
            <ToolButton label={toolLabel("eraser")} active={tool === "eraser"} onClick={() => setTool("eraser")}>
              <Eraser className="size-4" />
            </ToolButton>
            <ToolButton label={toolLabel("arrow")} active={tool === "arrow"} onClick={() => setTool("arrow")}>
              <ArrowUpRight className="size-4" />
            </ToolButton>
            <ToolButton label={toolLabel("rectangle")} active={tool === "rectangle"} onClick={() => setTool("rectangle")}>
              <SquareIcon className="size-4" />
            </ToolButton>
            <ToolButton label={toolLabel("text")} active={tool === "text"} onClick={() => setTool("text")}>
              <Type className="size-4" />
            </ToolButton>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1.5">
            {COLORS.map(swatch => (
              <SwatchButton
                key={swatch}
                color={swatch}
                active={swatch === color}
                onClick={() => setColor(swatch)}
              />
            ))}
          </div>

          <div className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-2 text-white/75">
            <input
              aria-label={tool === "text" ? "Text size" : "Brush size"}
              type="range"
              min={2}
              max={32}
              value={strokeSize}
              onChange={(event) => setStrokeSize(Number(event.target.value))}
              className="h-2 w-24 accent-white"
            />
            <span className="w-6 text-right text-[11px] tabular-nums">{strokeSize}</span>
          </div>

          {tool === "text" && (
            <input
              aria-label="Annotation text"
              value={textValue}
              onChange={(event) => setTextValue(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.08] px-3 text-sm text-white outline-none placeholder:text-white/45 focus:border-white/35 md:max-w-56"
              placeholder="Text"
            />
          )}

          <div className="ml-auto flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] p-1">
            <ToolButton label="Undo" disabled={!canUndo} onClick={undo}>
              <Undo2 className="size-4" />
            </ToolButton>
            <ToolButton label="Redo" disabled={!canRedo} onClick={redo}>
              <Redo2 className="size-4" />
            </ToolButton>
            <ToolButton label="Clear" disabled={!hasMarks} onClick={clear}>
              <Trash2 className="size-4" />
            </ToolButton>
            <span className="mx-1 h-5 w-px bg-white/12" />
            <ToolButton label="Zoom out" onClick={() => zoomBy(-0.25)}>
              <Minus className="size-4" />
            </ToolButton>
            <ToolButton label="Zoom in" onClick={() => zoomBy(0.25)}>
              <Plus className="size-4" />
            </ToolButton>
            <ToolButton label="Download" onClick={handleDownload}>
              <Download className="size-4" />
            </ToolButton>
            <ToolButton label={saveState === "saving" ? "Saving" : "Save"} disabled={!onSave || saveState === "saving"} onClick={handleSave}>
              <Save className="size-4" />
            </ToolButton>
          </div>
        </div>

        <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto bg-black/25">
          <div className="flex min-h-full min-w-full items-center justify-center p-3">
            <div
              className="relative isolate overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/15"
              style={displayWidth && displayHeight ? { width: displayWidth, height: displayHeight } : undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                src={imageUrl}
                alt={filename}
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget
                  setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
                }}
                className="block size-full select-none bg-black object-contain"
              />
              <canvas
                ref={canvasRef}
                aria-label="Image annotation canvas"
                className={cn(
                  "absolute inset-0 size-full touch-none",
                  tool === "eraser" ? "cursor-cell" : tool === "text" ? "cursor-text" : "cursor-crosshair"
                )}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={finishPointer}
                onPointerLeave={(event) => {
                  if (activePointerIdRef.current === event.pointerId) finishPointer(event)
                }}
              />
            </div>
          </div>

          {(saveState === "saved" || saveState === "error" || exportError) && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-white/12 bg-black/72 px-3 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md">
              {saveState === "saved" ? "Saved" : exportError ?? "Could not save"}
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
