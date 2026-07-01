"use client"

import * as React from "react"
import {
  ArrowUp,
  ArrowUpRight,
  Circle,
  Download,
  Eraser,
  Hand,
  Highlighter,
  Loader2,
  Minus,
  MoreVertical,
  MousePointer2,
  PenLine,
  Pipette,
  Plus,
  Redo2,
  Save,
  Slash,
  Square as SquareIcon,
  Trash,
  Trash2,
  Type,
  Undo2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePreviewZoomGestures } from "@/hooks/use-preview-zoom-gestures"
import { cn } from "@/lib/utils"

type ShapeKind = "arrow" | "line" | "rectangle" | "ellipse"
type AnnotationTool =
  | "select"
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | "arrow"
  | "line"
  | "rectangle"
  | "ellipse"
  | "text"

interface Point {
  x: number
  y: number
  pressure: number
}

interface PathMark {
  kind: "path"
  id: string
  tool: "pen" | "highlighter" | "eraser"
  color: string
  size: number
  points: Point[]
}

interface ShapeMark {
  kind: "shape"
  id: string
  shape: ShapeKind
  color: string
  size: number
  start: Point
  end: Point
}

interface TextMark {
  kind: "text"
  id: string
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
  onSend?: (file: File, message: string) => void | Promise<void>
  sendDisabled?: boolean
  sendDisabledMessage?: string
}

const COLORS = [
  "#f43f5e",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#38bdf8",
  "#a855f7",
  "#ffffff",
  "#111827",
]
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
// Tolerances are expressed in screen pixels and converted to image pixels at use time,
// so hit-testing feels the same regardless of zoom / fit scale.
const HIT_TOLERANCE = 12
const HANDLE_TOLERANCE = 13
const HANDLE_SIZE = 9

function toolShowsStrokePreview(tool: AnnotationTool) {
  switch (tool) {
    case "pen":
    case "highlighter":
    case "eraser":
    case "arrow":
    case "line":
    case "rectangle":
    case "ellipse":
      return true
    default:
      return false
  }
}

function effectiveStrokeSizeForTool(tool: AnnotationTool, strokeSize: number) {
  return Math.max(
    2,
    Math.round(tool === "eraser" ? strokeSize * 2.2 : strokeSize)
  )
}

function strokeSizeLabelForTool(tool: AnnotationTool, strokeSize: number) {
  if (tool === "text") return Math.max(14, Math.round(strokeSize * 2.4))
  return effectiveStrokeSizeForTool(tool, strokeSize)
}

function hexFromRgb(r: number, g: number, b: number) {
  return `#${[r, g, b].map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`
}

let markSequence = 0
function nextMarkId() {
  markSequence += 1
  return `mark-${markSequence}`
}

let sharedMeasureCtx: CanvasRenderingContext2D | null = null
function textFont(size: number) {
  return `600 ${size}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
}
function measureTextWidth(text: string, size: number) {
  if (typeof document === "undefined") return text.length * size * 0.6
  if (!sharedMeasureCtx)
    sharedMeasureCtx = document.createElement("canvas").getContext("2d")
  if (!sharedMeasureCtx) return text.length * size * 0.6
  sharedMeasureCtx.font = textFont(size)
  return sharedMeasureCtx.measureText(text).width
}

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

function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function markBounds(mark: AnnotationMark): Bounds {
  if (mark.kind === "path") {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const point of mark.points) {
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    const radius = mark.size / 2
    return {
      minX: minX - radius,
      minY: minY - radius,
      maxX: maxX + radius,
      maxY: maxY + radius,
    }
  }
  if (mark.kind === "text") {
    const width = measureTextWidth(mark.text, mark.size)
    return {
      minX: mark.point.x,
      minY: mark.point.y - mark.size * 0.86,
      maxX: mark.point.x + width,
      maxY: mark.point.y + mark.size * 0.22,
    }
  }
  return {
    minX: Math.min(mark.start.x, mark.end.x),
    minY: Math.min(mark.start.y, mark.end.y),
    maxX: Math.max(mark.start.x, mark.end.x),
    maxY: Math.max(mark.start.y, mark.end.y),
  }
}

function hitTestMark(mark: AnnotationMark, p: Point, tolerance: number) {
  if (mark.kind === "path") {
    const reach = tolerance + mark.size / 2
    if (mark.points.length === 1) return distance(mark.points[0], p) <= reach
    for (let i = 1; i < mark.points.length; i += 1) {
      if (distanceToSegment(p, mark.points[i - 1], mark.points[i]) <= reach)
        return true
    }
    return false
  }
  if (
    mark.kind === "shape" &&
    (mark.shape === "line" || mark.shape === "arrow")
  ) {
    return (
      distanceToSegment(p, mark.start, mark.end) <= tolerance + mark.size / 2
    )
  }
  const b = markBounds(mark)
  return (
    p.x >= b.minX - tolerance &&
    p.x <= b.maxX + tolerance &&
    p.y >= b.minY - tolerance &&
    p.y <= b.maxY + tolerance
  )
}

interface HandleSpec {
  id: string
  x: number
  y: number
}

function shapeHandles(mark: AnnotationMark): HandleSpec[] {
  if (mark.kind !== "shape") return []
  if (mark.shape === "line" || mark.shape === "arrow") {
    return [
      { id: "start", x: mark.start.x, y: mark.start.y },
      { id: "end", x: mark.end.x, y: mark.end.y },
    ]
  }
  const b = markBounds(mark)
  return [
    { id: "nw", x: b.minX, y: b.minY },
    { id: "ne", x: b.maxX, y: b.minY },
    { id: "sw", x: b.minX, y: b.maxY },
    { id: "se", x: b.maxX, y: b.maxY },
  ]
}

function handleAtPoint(
  mark: AnnotationMark,
  p: Point,
  tolerance: number
): string | null {
  for (const handle of shapeHandles(mark)) {
    if (
      Math.abs(p.x - handle.x) <= tolerance &&
      Math.abs(p.y - handle.y) <= tolerance
    )
      return handle.id
  }
  return null
}

function translateMark(
  mark: AnnotationMark,
  dx: number,
  dy: number
): AnnotationMark {
  if (mark.kind === "path") {
    return {
      ...mark,
      points: mark.points.map((p) => ({
        x: p.x + dx,
        y: p.y + dy,
        pressure: p.pressure,
      })),
    }
  }
  if (mark.kind === "shape") {
    return {
      ...mark,
      start: {
        x: mark.start.x + dx,
        y: mark.start.y + dy,
        pressure: mark.start.pressure,
      },
      end: {
        x: mark.end.x + dx,
        y: mark.end.y + dy,
        pressure: mark.end.pressure,
      },
    }
  }
  return {
    ...mark,
    point: {
      x: mark.point.x + dx,
      y: mark.point.y + dy,
      pressure: mark.point.pressure,
    },
  }
}

function resizeShapeMark(mark: ShapeMark, handle: string, p: Point): ShapeMark {
  if (mark.shape === "line" || mark.shape === "arrow") {
    if (handle === "start")
      return { ...mark, start: { x: p.x, y: p.y, pressure: 1 } }
    return { ...mark, end: { x: p.x, y: p.y, pressure: 1 } }
  }
  let minX = Math.min(mark.start.x, mark.end.x)
  let maxX = Math.max(mark.start.x, mark.end.x)
  let minY = Math.min(mark.start.y, mark.end.y)
  let maxY = Math.max(mark.start.y, mark.end.y)
  if (handle.includes("w")) minX = p.x
  if (handle.includes("e")) maxX = p.x
  if (handle.includes("n")) minY = p.y
  if (handle.includes("s")) maxY = p.y
  return {
    ...mark,
    start: { x: Math.min(minX, maxX), y: Math.min(minY, maxY), pressure: 1 },
    end: { x: Math.max(minX, maxX), y: Math.max(minY, maxY), pressure: 1 },
  }
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  size: number
) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const length = Math.max(size * 4, 14)
  const spread = Math.PI / 7
  ctx.beginPath()
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(
    end.x - length * Math.cos(angle - spread),
    end.y - length * Math.sin(angle - spread)
  )
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(
    end.x - length * Math.cos(angle + spread),
    end.y - length * Math.sin(angle + spread)
  )
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
    const pressure =
      mark.tool === "eraser" ? 1 : (prev.pressure + next.pressure) / 2
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
  } else if (mark.shape === "ellipse") {
    const cx = (mark.start.x + mark.end.x) / 2
    const cy = (mark.start.y + mark.end.y) / 2
    const rx = Math.abs(mark.end.x - mark.start.x) / 2
    const ry = Math.abs(mark.end.y - mark.start.y) / 2
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (mark.shape === "line") {
    ctx.beginPath()
    ctx.moveTo(mark.start.x, mark.start.y)
    ctx.lineTo(mark.end.x, mark.end.y)
    ctx.stroke()
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
  ctx.font = textFont(mark.size)
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

function drawSelection(
  ctx: CanvasRenderingContext2D,
  mark: AnnotationMark,
  invScale: number
) {
  const b = markBounds(mark)
  const pad = 4 * invScale
  ctx.save()
  ctx.strokeStyle = "rgba(56,189,248,0.95)"
  ctx.lineWidth = 1.5 * invScale
  ctx.setLineDash([6 * invScale, 4 * invScale])
  ctx.strokeRect(
    b.minX - pad,
    b.minY - pad,
    b.maxX - b.minX + pad * 2,
    b.maxY - b.minY + pad * 2
  )
  ctx.setLineDash([])

  const handleSize = HANDLE_SIZE * invScale
  for (const handle of shapeHandles(mark)) {
    ctx.beginPath()
    ctx.rect(
      handle.x - handleSize / 2,
      handle.y - handleSize / 2,
      handleSize,
      handleSize
    )
    ctx.fillStyle = "#ffffff"
    ctx.fill()
    ctx.strokeStyle = "rgba(2,132,199,0.95)"
    ctx.lineWidth = 1.5 * invScale
    ctx.stroke()
  }
  ctx.restore()
}

function toolLabel(tool: AnnotationTool) {
  switch (tool) {
    case "select":
      return "Select / move"
    case "hand":
      return "Pan"
    case "pen":
      return "Pen"
    case "highlighter":
      return "Highlighter"
    case "eraser":
      return "Eraser"
    case "arrow":
      return "Arrow"
    case "line":
      return "Line"
    case "rectangle":
      return "Rectangle"
    case "ellipse":
      return "Ellipse"
    case "text":
      return "Text"
    default:
      return "Tool"
  }
}

// A single in-progress pointer interaction. Only one is active at a time.
type Interaction =
  | { kind: "draw"; pointerId: number; mark: AnnotationMark; moved: boolean }
  | { kind: "pan"; pointerId: number; last: { x: number; y: number } }
  | {
      kind: "move"
      pointerId: number
      targetId: string
      original: AnnotationMark
      start: Point
      moved: boolean
    }
  | {
      kind: "resize"
      pointerId: number
      targetId: string
      original: ShapeMark
      handle: string
      moved: boolean
    }

// What to overlay on top of the committed marks while an interaction is live.
type Preview =
  | { add: AnnotationMark }
  | { replaceId: string; mark: AnnotationMark }
  | null

function ToolButton({
  label,
  active,
  disabled,
  size = "icon-sm",
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  size?: "icon" | "icon-sm"
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={size}
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
      <TooltipContent side="bottom" className="z-[140]">
        {label}
      </TooltipContent>
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
            active
              ? "scale-110 ring-2 ring-white"
              : "hover:scale-105 hover:ring-1 hover:ring-white/65"
          )}
        >
          <span
            className="size-4 rounded-full border border-black/20"
            style={{ backgroundColor: color }}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="z-[140]">
        Color
      </TooltipContent>
    </Tooltip>
  )
}

function CustomColorButton({
  color,
  size = "icon-sm",
  onChange,
}: {
  color: string
  size?: "icon" | "icon-sm"
  onChange: (color: string) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label
          aria-label="Custom color"
          className={cn(
            "relative grid cursor-pointer place-items-center overflow-hidden border border-white/16 bg-white/[0.06] transition-colors hover:bg-white/12",
            size === "icon"
              ? "size-8 rounded-md"
              : "size-7 rounded-[min(var(--radius-md),12px)]"
          )}
        >
          <span
            className="absolute inset-1 rounded-md border border-black/25 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.3)]"
            style={{ backgroundColor: color }}
          />
          <input
            aria-label="Custom color"
            type="color"
            value={color}
            onChange={(event) => onChange(event.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="z-[140]">
        Custom color
      </TooltipContent>
    </Tooltip>
  )
}

export function ImageAnnotationEditor({
  imageUrl,
  filename,
  onSave,
  onSend,
  sendDisabled = false,
  sendDisabledMessage,
}: ImageAnnotationEditorProps) {
  const imageRef = React.useRef<HTMLImageElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const interactionRef = React.useRef<Interaction | null>(null)
  const previewRef = React.useRef<Preview>(null)
  const marksRef = React.useRef<AnnotationMark[]>([])
  const selectedIdRef = React.useRef<string | null>(null)
  const brushPreviewNodeRef = React.useRef<HTMLDivElement>(null)
  const brushPreviewVisibleRef = React.useRef(false)
  const mountedRef = React.useRef(true)

  const [imageSize, setImageSize] = React.useState({ width: 0, height: 0 })
  const [viewportSize, setViewportSize] = React.useState({
    width: 0,
    height: 0,
  })
  const [marks, setMarks] = React.useState<AnnotationMark[]>([])
  const [past, setPast] = React.useState<AnnotationMark[][]>([])
  const [future, setFuture] = React.useState<AnnotationMark[][]>([])
  const [selectedId, setSelectedIdState] = React.useState<string | null>(null)
  const [tool, setTool] = React.useState<AnnotationTool>("select")
  const [color, setColor] = React.useState(COLORS[0])
  const [strokeSize, setStrokeSize] = React.useState(8)
  const [zoom, setZoom] = React.useState(1)
  const [isPanning, setIsPanning] = React.useState(false)
  const [textValue, setTextValue] = React.useState("Note")
  const [saveState, setSaveState] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle")
  const [sendText, setSendText] = React.useState("")
  const [sendState, setSendState] = React.useState<
    "idle" | "sending" | "sent" | "error"
  >("idle")
  const [exportError, setExportError] = React.useState<string | null>(null)
  const [sendError, setSendError] = React.useState<string | null>(null)
  const [colorPickerOpen, setColorPickerOpen] = React.useState(false)
  const [colorSampling, setColorSampling] = React.useState(false)
  const [brushPreviewVisible, setBrushPreviewVisible] = React.useState(false)
  const isMobile = useIsMobile()

  const fitScale = React.useMemo(() => {
    if (
      imageSize.width <= 0 ||
      imageSize.height <= 0 ||
      viewportSize.width <= 0 ||
      viewportSize.height <= 0
    )
      return 1
    const availableWidth = Math.max(1, viewportSize.width - 24)
    const availableHeight = Math.max(1, viewportSize.height - 24)
    return Math.min(
      availableWidth / imageSize.width,
      availableHeight / imageSize.height,
      1
    )
  }, [
    imageSize.height,
    imageSize.width,
    viewportSize.height,
    viewportSize.width,
  ])
  const displayScale = fitScale * zoom
  const displayWidth =
    imageSize.width > 0
      ? Math.max(1, imageSize.width * displayScale)
      : undefined
  const displayHeight =
    imageSize.height > 0
      ? Math.max(1, imageSize.height * displayScale)
      : undefined

  // Large photos fit at a tiny scale, so a fixed zoom ceiling would never
  // reach readable detail — always allow zooming up to ~2x native pixels.
  const maxZoom = fitScale > 0 ? Math.max(MAX_ZOOM, 2 / fitScale) : MAX_ZOOM
  const maxZoomRef = React.useRef(maxZoom)
  const zoomRef = React.useRef(zoom)
  React.useEffect(() => {
    maxZoomRef.current = maxZoom
    zoomRef.current = zoom
  }, [maxZoom, zoom])
  const zoomAnchorRef = React.useRef<{
    ax: number
    ay: number
    fx: number
    fy: number
  } | null>(null)

  const setSelection = React.useCallback((id: string | null) => {
    selectedIdRef.current = id
    setSelectedIdState(id)
  }, [])

  const drawAll = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || imageSize.width <= 0 || imageSize.height <= 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const preview = previewRef.current
    const list = marksRef.current
    for (const mark of list) {
      if (preview && "replaceId" in preview && preview.replaceId === mark.id)
        drawMark(ctx, preview.mark)
      else drawMark(ctx, mark)
    }
    if (preview && "add" in preview) drawMark(ctx, preview.add)

    if (tool === "select" && selectedId) {
      let selected: AnnotationMark | null =
        list.find((mark) => mark.id === selectedId) ?? null
      if (preview && "replaceId" in preview && preview.replaceId === selectedId)
        selected = preview.mark
      if (selected)
        drawSelection(ctx, selected, 1 / Math.max(0.0001, displayScale))
    }
  }, [displayScale, imageSize.height, imageSize.width, selectedId, tool])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

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

  // Seed the size from an already-decoded image. Cached blob/upload URLs (and
  // data URLs) can finish loading before React attaches the onLoad handler, in
  // which case onLoad never fires and the editor would stay stuck at 0×0.
  React.useEffect(() => {
    const image = imageRef.current
    if (image && image.complete && image.naturalWidth > 0) {
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
    }
  }, [imageUrl])

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

  const commit = React.useCallback((next: AnnotationMark[]) => {
    const prev = marksRef.current
    setPast((stack) => [...stack, prev])
    setFuture([])
    marksRef.current = next
    setMarks(next)
    setSaveState("idle")
    setSendState("idle")
    setExportError(null)
    setSendError(null)
  }, [])

  const addMark = React.useCallback(
    (mark: AnnotationMark) => {
      commit([...marksRef.current, mark])
    },
    [commit]
  )

  const undo = React.useCallback(() => {
    setPast((stack) => {
      if (stack.length === 0) return stack
      const prevState = stack[stack.length - 1]
      setFuture((f) => [...f, marksRef.current])
      marksRef.current = prevState
      setMarks(prevState)
      setSelection(
        prevState.some((mark) => mark.id === selectedIdRef.current)
          ? selectedIdRef.current
          : null
      )
      return stack.slice(0, -1)
    })
    setSaveState("idle")
  }, [setSelection])

  const redo = React.useCallback(() => {
    setFuture((stack) => {
      if (stack.length === 0) return stack
      const nextState = stack[stack.length - 1]
      setPast((p) => [...p, marksRef.current])
      marksRef.current = nextState
      setMarks(nextState)
      setSelection(
        nextState.some((mark) => mark.id === selectedIdRef.current)
          ? selectedIdRef.current
          : null
      )
      return stack.slice(0, -1)
    })
    setSaveState("idle")
  }, [setSelection])

  const clear = React.useCallback(() => {
    if (marksRef.current.length === 0) return
    commit([])
    setSelection(null)
  }, [commit, setSelection])

  const deleteSelected = React.useCallback(() => {
    const id = selectedIdRef.current
    if (!id) return
    commit(marksRef.current.filter((mark) => mark.id !== id))
    setSelection(null)
  }, [commit, setSelection])

  const chooseTool = React.useCallback(
    (next: AnnotationTool) => {
      setTool(next)
      setColorSampling(false)
      if (next !== "select") setSelection(null)
    },
    [setSelection]
  )

  const chooseColor = React.useCallback(
    (next: string) => {
      setColor(next)
      setColorSampling(false)
      setExportError(null)
      const id = selectedIdRef.current
      if (tool === "select" && id) {
        commit(
          marksRef.current.map((mark) =>
            mark.id === id ? { ...mark, color: next } : mark
          )
        )
      }
    },
    [commit, tool]
  )

  const toggleColorSampling = React.useCallback(() => {
    setColorSampling((active) => !active)
    setExportError(null)
  }, [])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable='true']")) return
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "y")) {
        event.preventDefault()
        if (key === "z" && !event.shiftKey) undo()
        else redo()
        return
      }
      if (event.metaKey || event.ctrlKey) return
      if (key === "delete" || key === "backspace") {
        if (selectedIdRef.current) {
          event.preventDefault()
          deleteSelected()
        }
      } else if (key === "escape") {
        if (colorSampling) {
          setColorSampling(false)
          return
        }
        if (selectedIdRef.current) setSelection(null)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [colorSampling, deleteSelected, redo, setSelection, undo])

  const canUndo = past.length > 0
  const canRedo = future.length > 0
  const hasMarks = marks.length > 0
  const hasSelection = tool === "select" && selectedId !== null

  const pointFromEvent = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
      const canvas = canvasRef.current
      if (!canvas || imageSize.width <= 0 || imageSize.height <= 0) return null
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return {
        x: clamp(
          ((event.clientX - rect.left) / rect.width) * imageSize.width,
          0,
          imageSize.width
        ),
        y: clamp(
          ((event.clientY - rect.top) / rect.height) * imageSize.height,
          0,
          imageSize.height
        ),
        pressure: event.pressure > 0 ? event.pressure : 0.75,
      }
    },
    [imageSize.height, imageSize.width]
  )

  const screenToImageScale = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || imageSize.width <= 0) return 1
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0) return 1
    return imageSize.width / rect.width
  }, [imageSize.width])

  const sampleColorAtPoint = React.useCallback(
    (point: Point) => {
      const image = imageRef.current
      if (!image || imageSize.width <= 0 || imageSize.height <= 0) {
        throw new Error("Image is not ready yet.")
      }

      const output = document.createElement("canvas")
      output.width = imageSize.width
      output.height = imageSize.height
      const ctx = output.getContext("2d", { willReadFrequently: true })
      if (!ctx) throw new Error("Canvas is not available.")
      ctx.drawImage(image, 0, 0, imageSize.width, imageSize.height)

      const overlay = document.createElement("canvas")
      overlay.width = imageSize.width
      overlay.height = imageSize.height
      const overlayCtx = overlay.getContext("2d")
      if (!overlayCtx) throw new Error("Canvas is not available.")
      for (const mark of marksRef.current) drawMark(overlayCtx, mark)
      ctx.drawImage(overlay, 0, 0)

      const x = clamp(Math.floor(point.x), 0, imageSize.width - 1)
      const y = clamp(Math.floor(point.y), 0, imageSize.height - 1)
      const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data
      if (a >= 255) return hexFromRgb(r, g, b)
      return hexFromRgb((r * a) / 255, (g * a) / 255, (b * a) / 255)
    },
    [imageSize.height, imageSize.width]
  )

  const updateBrushPreviewFromPointer = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const node = brushPreviewNodeRef.current
      if (node) {
        node.style.left = `${clamp(event.clientX - rect.left, 0, rect.width)}px`
        node.style.top = `${clamp(event.clientY - rect.top, 0, rect.height)}px`
      }
      if (!brushPreviewVisibleRef.current) {
        brushPreviewVisibleRef.current = true
        setBrushPreviewVisible(true)
      }
    },
    []
  )

  const hideBrushPreview = React.useCallback(() => {
    if (!brushPreviewVisibleRef.current) return
    brushPreviewVisibleRef.current = false
    setBrushPreviewVisible(false)
  }, [])

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return
      const point = pointFromEvent(event)
      if (!point) return
      updateBrushPreviewFromPointer(event)
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const imageScale = screenToImageScale()

      if (colorSampling) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          // Pointer capture may already be released by the browser.
        }
        try {
          chooseColor(sampleColorAtPoint(point))
          setColorPickerOpen(false)
        } catch (error) {
          setColorSampling(false)
          setExportError(
            error instanceof Error
              ? error.message
              : "Could not sample this image."
          )
        }
        return
      }

      if (tool === "hand") {
        interactionRef.current = {
          kind: "pan",
          pointerId: event.pointerId,
          last: { x: event.clientX, y: event.clientY },
        }
        setIsPanning(true)
        return
      }

      if (tool === "select") {
        const selected = selectedIdRef.current
          ? (marksRef.current.find(
              (mark) => mark.id === selectedIdRef.current
            ) ?? null)
          : null
        if (selected && selected.kind === "shape") {
          const handle = handleAtPoint(
            selected,
            point,
            HANDLE_TOLERANCE * imageScale
          )
          if (handle) {
            interactionRef.current = {
              kind: "resize",
              pointerId: event.pointerId,
              targetId: selected.id,
              original: selected,
              handle,
              moved: false,
            }
            return
          }
        }
        const tolerance = HIT_TOLERANCE * imageScale
        let hit: AnnotationMark | null = null
        for (let i = marksRef.current.length - 1; i >= 0; i -= 1) {
          if (hitTestMark(marksRef.current[i], point, tolerance)) {
            hit = marksRef.current[i]
            break
          }
        }
        if (hit) {
          setSelection(hit.id)
          interactionRef.current = {
            kind: "move",
            pointerId: event.pointerId,
            targetId: hit.id,
            original: hit,
            start: point,
            moved: false,
          }
          return
        }
        // Empty space: drop the selection and pan the image (preserves drag-to-pan).
        setSelection(null)
        interactionRef.current = {
          kind: "pan",
          pointerId: event.pointerId,
          last: { x: event.clientX, y: event.clientY },
        }
        setIsPanning(true)
        return
      }

      const scaledSize = strokeSize * imageScale
      if (tool === "text") {
        const text = textValue.trim()
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          // Pointer capture may already be released by the browser.
        }
        if (!text) return
        addMark({
          kind: "text",
          id: nextMarkId(),
          color,
          point,
          size: Math.max(14, scaledSize * 2.4),
          text,
        })
        return
      }

      let mark: AnnotationMark
      if (
        tool === "arrow" ||
        tool === "line" ||
        tool === "rectangle" ||
        tool === "ellipse"
      ) {
        mark = {
          kind: "shape",
          id: nextMarkId(),
          shape: tool,
          color,
          size: Math.max(2, scaledSize),
          start: point,
          end: point,
        }
      } else {
        mark = {
          kind: "path",
          id: nextMarkId(),
          tool,
          color,
          size: Math.max(2, tool === "eraser" ? scaledSize * 2.2 : scaledSize),
          points: [point],
        }
      }
      interactionRef.current = {
        kind: "draw",
        pointerId: event.pointerId,
        mark,
        moved: false,
      }
      previewRef.current = { add: mark }
      drawAll()
    },
    [
      addMark,
      chooseColor,
      color,
      colorSampling,
      drawAll,
      pointFromEvent,
      sampleColorAtPoint,
      screenToImageScale,
      setSelection,
      strokeSize,
      textValue,
      tool,
      updateBrushPreviewFromPointer,
    ]
  )

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      updateBrushPreviewFromPointer(event)
      const interaction = interactionRef.current
      if (!interaction || interaction.pointerId !== event.pointerId) return
      event.preventDefault()

      if (interaction.kind === "pan") {
        const viewport = viewportRef.current
        if (viewport) {
          viewport.scrollLeft -= event.clientX - interaction.last.x
          viewport.scrollTop -= event.clientY - interaction.last.y
          interaction.last = { x: event.clientX, y: event.clientY }
        }
        return
      }

      const point = pointFromEvent(event)
      if (!point) return

      if (interaction.kind === "draw") {
        const mark = interaction.mark
        if (mark.kind === "path") {
          const last = mark.points.at(-1)
          if (!last || distance(last, point) >= Math.max(1, mark.size * 0.18))
            mark.points.push(point)
        } else if (mark.kind === "shape") {
          mark.end = point
        }
        interaction.moved = true
        previewRef.current = { add: mark }
        drawAll()
        return
      }

      if (interaction.kind === "move") {
        const dx = point.x - interaction.start.x
        const dy = point.y - interaction.start.y
        if (dx !== 0 || dy !== 0) interaction.moved = true
        previewRef.current = {
          replaceId: interaction.targetId,
          mark: translateMark(interaction.original, dx, dy),
        }
        drawAll()
        return
      }

      // resize
      interaction.moved = true
      previewRef.current = {
        replaceId: interaction.targetId,
        mark: resizeShapeMark(interaction.original, interaction.handle, point),
      }
      drawAll()
    },
    [drawAll, pointFromEvent, updateBrushPreviewFromPointer]
  )

  const finishPointer = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const interaction = interactionRef.current
      if (!interaction || interaction.pointerId !== event.pointerId) return
      interactionRef.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // The browser can release capture automatically when the pointer leaves.
      }

      if (interaction.kind === "pan") {
        setIsPanning(false)
        return
      }

      const preview = previewRef.current
      previewRef.current = null

      if (interaction.kind === "draw") {
        const mark = interaction.mark
        if (mark.kind === "path" && mark.points.length < 2) {
          drawAll()
          return
        }
        if (
          mark.kind === "shape" &&
          distance(mark.start, mark.end) < mark.size * 1.5
        ) {
          drawAll()
          return
        }
        addMark(mark)
        return
      }

      // move / resize
      if (!interaction.moved || !preview || !("replaceId" in preview)) {
        drawAll()
        return
      }
      const finalMark = preview.mark
      commit(
        marksRef.current.map((mark) =>
          mark.id === interaction.targetId ? finalMark : mark
        )
      )
    },
    [addMark, commit, drawAll]
  )

  // --- Anchored zoom -------------------------------------------------------
  // Every zoom keeps one image point fixed under the gesture (cursor, pinch
  // midpoint, or viewport center for buttons): the anchor is remembered as a
  // fraction of the image card, and once React commits the resized layout a
  // layout effect shifts the scroll position so that point lands back under
  // the anchor. Measuring real geometry keeps it exact across the
  // fits-viewport → overflows-viewport transition.
  const zoomAtPoint = React.useCallback(
    (clientX: number, clientY: number, nextZoomRaw: number) => {
      const next = clamp(
        Number(nextZoomRaw.toFixed(3)),
        MIN_ZOOM,
        maxZoomRef.current
      )
      if (next === zoomRef.current) return
      const viewport = viewportRef.current
      const card = cardRef.current
      if (!viewport || !card) {
        setZoom(next)
        return
      }
      const viewportRect = viewport.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      zoomAnchorRef.current = {
        ax: clientX - viewportRect.left,
        ay: clientY - viewportRect.top,
        fx:
          cardRect.width > 0 ? (clientX - cardRect.left) / cardRect.width : 0.5,
        fy:
          cardRect.height > 0
            ? (clientY - cardRect.top) / cardRect.height
            : 0.5,
      }
      setZoom(next)
    },
    []
  )

  React.useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = null
    if (!anchor) return
    const viewport = viewportRef.current
    const card = cardRef.current
    if (!viewport || !card) return
    const viewportRect = viewport.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    viewport.scrollLeft +=
      cardRect.left - viewportRect.left + anchor.fx * cardRect.width - anchor.ax
    viewport.scrollTop +=
      cardRect.top - viewportRect.top + anchor.fy * cardRect.height - anchor.ay
  }, [zoom])

  const zoomBy = React.useCallback(
    (delta: number) => {
      const viewport = viewportRef.current
      if (!viewport) {
        setZoom((value) =>
          clamp(
            Number((value + delta).toFixed(2)),
            MIN_ZOOM,
            maxZoomRef.current
          )
        )
        return
      }
      const rect = viewport.getBoundingClientRect()
      zoomAtPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        zoomRef.current + delta
      )
    },
    [zoomAtPoint]
  )

  // A second finger landing mid-stroke turns the gesture into a pinch: throw
  // away the half-drawn mark instead of committing it.
  const cancelPointerInteraction = React.useCallback(() => {
    if (!interactionRef.current) return
    interactionRef.current = null
    previewRef.current = null
    setIsPanning(false)
    drawAll()
  }, [drawAll])

  // Ctrl+scroll, trackpad pinch and touch pinch-to-zoom on the image viewport.
  usePreviewZoomGestures(viewportRef, {
    onZoomAt: React.useCallback(
      (x: number, y: number, factor: number) => {
        zoomAtPoint(x, y, zoomRef.current * factor)
      },
      [zoomAtPoint]
    ),
    onPinchStart: cancelPointerInteraction,
    onPinchPan: React.useCallback((dx: number, dy: number) => {
      const viewport = viewportRef.current
      if (!viewport) return
      viewport.scrollLeft -= dx
      viewport.scrollTop -= dy
    }, []),
  })

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

    const blob = await new Promise<Blob | null>((resolve) =>
      output.toBlob(resolve, "image/png", 0.95)
    )
    if (!blob) throw new Error("Could not export the annotated image.")
    return blob
  }, [imageSize.height, imageSize.width])

  const handleDownload = React.useCallback(async () => {
    try {
      setExportError(null)
      const blob = await buildAnnotatedBlob()
      downloadBlob(blob, annotatedFilename(filename))
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Could not export this image."
      )
    }
  }, [buildAnnotatedBlob, filename])

  const handleSave = React.useCallback(async () => {
    if (!onSave) return
    try {
      setSaveState("saving")
      setExportError(null)
      const blob = await buildAnnotatedBlob()
      const file = new File([blob], annotatedFilename(filename), {
        type: "image/png",
      })
      await onSave(file)
      if (mountedRef.current) setSaveState("saved")
    } catch (error) {
      if (!mountedRef.current) return
      setSaveState("error")
      setExportError(
        error instanceof Error ? error.message : "Could not save this image."
      )
    }
  }, [buildAnnotatedBlob, filename, onSave])

  const handleSend = React.useCallback(async () => {
    if (!onSend || sendDisabled || sendState === "sending") return
    try {
      setSendState("sending")
      setExportError(null)
      setSendError(null)
      const blob = await buildAnnotatedBlob()
      const file = new File([blob], annotatedFilename(filename), {
        type: "image/png",
      })
      await onSend(file, sendText.trim())
      if (!mountedRef.current) return
      setSendState("sent")
      setSendText("")
    } catch (error) {
      if (!mountedRef.current) return
      setSendState("error")
      setSendError(
        error instanceof Error ? error.message : "Could not send this image."
      )
    }
  }, [buildAnnotatedBlob, filename, onSend, sendDisabled, sendState, sendText])

  const brushPreviewSize = effectiveStrokeSizeForTool(tool, strokeSize)
  const brushSizeLabel = strokeSizeLabelForTool(tool, strokeSize)
  const shouldShowBrushPreview =
    brushPreviewVisible &&
    toolShowsStrokePreview(tool) &&
    imageSize.width > 0 &&
    imageSize.height > 0
  const brushPreviewFill =
    tool === "highlighter"
      ? `${color}4d`
      : tool === "eraser"
        ? "rgba(255,255,255,0.08)"
        : "transparent"
  const brushPreviewBorder =
    tool === "eraser" ? "rgba(255,255,255,0.92)" : color

  const cursorClass = colorSampling
    ? "cursor-copy"
    : tool === "hand"
      ? isPanning
        ? "cursor-grabbing"
        : "cursor-grab"
      : tool === "select"
        ? isPanning
          ? "cursor-grabbing"
          : "cursor-default"
        : tool === "eraser"
          ? "cursor-cell"
          : tool === "text"
            ? "cursor-text"
            : "cursor-crosshair"

  const buttonSize = isMobile ? ("icon" as const) : ("icon-sm" as const)

  const navigationGroup = (
    <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] p-1">
      <ToolButton
        label={toolLabel("select")}
        size={buttonSize}
        active={tool === "select"}
        onClick={() => chooseTool("select")}
      >
        <MousePointer2 className="size-4" />
      </ToolButton>
      <ToolButton
        label={toolLabel("hand")}
        size={buttonSize}
        active={tool === "hand"}
        onClick={() => chooseTool("hand")}
      >
        <Hand className="size-4" />
      </ToolButton>
      {hasSelection && (
        <ToolButton
          label="Delete selection"
          size={buttonSize}
          onClick={deleteSelected}
        >
          <Trash className="size-4" />
        </ToolButton>
      )}
    </div>
  )

  const drawingToolsGroup = (
    <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] p-1">
      <ToolButton
        label={toolLabel("pen")}
        size={buttonSize}
        active={tool === "pen"}
        onClick={() => chooseTool("pen")}
      >
        <PenLine className="size-4" />
      </ToolButton>
      <ToolButton
        label={toolLabel("highlighter")}
        size={buttonSize}
        active={tool === "highlighter"}
        onClick={() => chooseTool("highlighter")}
      >
        <Highlighter className="size-4" />
      </ToolButton>
      <ToolButton
        label={toolLabel("eraser")}
        size={buttonSize}
        active={tool === "eraser"}
        onClick={() => chooseTool("eraser")}
      >
        <Eraser className="size-4" />
      </ToolButton>
      <span className="mx-0.5 h-5 w-px bg-white/12" />
      <ToolButton
        label={toolLabel("arrow")}
        size={buttonSize}
        active={tool === "arrow"}
        onClick={() => chooseTool("arrow")}
      >
        <ArrowUpRight className="size-4" />
      </ToolButton>
      <ToolButton
        label={toolLabel("line")}
        size={buttonSize}
        active={tool === "line"}
        onClick={() => chooseTool("line")}
      >
        <Slash className="size-4" />
      </ToolButton>
      <ToolButton
        label={toolLabel("rectangle")}
        size={buttonSize}
        active={tool === "rectangle"}
        onClick={() => chooseTool("rectangle")}
      >
        <SquareIcon className="size-4" />
      </ToolButton>
      <ToolButton
        label={toolLabel("ellipse")}
        size={buttonSize}
        active={tool === "ellipse"}
        onClick={() => chooseTool("ellipse")}
      >
        <Circle className="size-4" />
      </ToolButton>
      <span className="mx-0.5 h-5 w-px bg-white/12" />
      <ToolButton
        label={toolLabel("text")}
        size={buttonSize}
        active={tool === "text"}
        onClick={() => chooseTool("text")}
      >
        <Type className="size-4" />
      </ToolButton>
    </div>
  )

  const strokeSlider = (
    <div className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-2 text-white/75">
      <span
        className="grid size-6 shrink-0 place-items-center"
        aria-hidden="true"
      >
        <span
          className={cn(
            "rounded-full border shadow-[0_0_0_1px_rgba(0,0,0,0.45)]",
            tool === "eraser" && "border-dashed"
          )}
          style={{
            width: clamp(brushSizeLabel, 4, 22),
            height: clamp(brushSizeLabel, 4, 22),
            borderColor: brushPreviewBorder,
            backgroundColor: brushPreviewFill,
          }}
        />
      </span>
      <input
        aria-label={tool === "text" ? "Text size" : "Brush size"}
        type="range"
        min={2}
        max={32}
        value={strokeSize}
        onChange={(event) => setStrokeSize(Number(event.target.value))}
        className={cn("h-2 accent-white", isMobile ? "w-20" : "w-24")}
      />
      <span className="w-10 text-right text-[11px] tabular-nums">
        {brushSizeLabel}px
      </span>
    </div>
  )

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        {isMobile ? (
          // Phone layout: a fixed row with navigation / history / color +
          // overflow actions, then a horizontally scrollable row of drawing
          // tools — instead of the desktop toolbar wrapping into a jumble.
          <div className="flex shrink-0 flex-col gap-1.5 border-y border-white/10 bg-black/35 px-2 py-1.5 backdrop-blur-md">
            <div className="flex items-center gap-1.5">
              {navigationGroup}
              <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] p-1">
                <ToolButton
                  label="Undo"
                  size={buttonSize}
                  disabled={!canUndo}
                  onClick={undo}
                >
                  <Undo2 className="size-4" />
                </ToolButton>
                <ToolButton
                  label="Redo"
                  size={buttonSize}
                  disabled={!canRedo}
                  onClick={redo}
                >
                  <Redo2 className="size-4" />
                </ToolButton>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] p-1">
                <Popover
                  open={colorPickerOpen}
                  onOpenChange={setColorPickerOpen}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Color"
                      className="grid size-8 place-items-center rounded-md transition-colors hover:bg-white/12"
                    >
                      <span
                        className="size-5 rounded-full border border-white/35"
                        style={{ backgroundColor: color }}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="bottom"
                    align="end"
                    className="z-[140] w-52 rounded-xl border border-white/12 bg-neutral-950/92 p-2.5 shadow-2xl backdrop-blur-md"
                  >
                    <div className="grid grid-cols-4 gap-2.5">
                      {COLORS.map((swatch) => (
                        <SwatchButton
                          key={swatch}
                          color={swatch}
                          active={swatch === color}
                          onClick={() => {
                            chooseColor(swatch)
                            setColorPickerOpen(false)
                          }}
                        />
                      ))}
                    </div>
                    <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2">
                      <CustomColorButton
                        color={color}
                        size="icon"
                        onChange={chooseColor}
                      />
                      <ToolButton
                        label={
                          colorSampling
                            ? "Cancel color picker"
                            : "Pick color from image"
                        }
                        size="icon"
                        active={colorSampling}
                        onClick={() => {
                          toggleColorSampling()
                          setColorPickerOpen(false)
                        }}
                      >
                        <Pipette className="size-4" />
                      </ToolButton>
                      <span className="min-w-0 flex-1 truncate text-right text-[11px] font-medium text-white/62 tabular-nums">
                        {color.toUpperCase()}
                      </span>
                    </div>
                  </PopoverContent>
                </Popover>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="More actions"
                      className="text-white/72 hover:bg-white/12 hover:text-white"
                    >
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="z-[140] w-44 border border-white/12 bg-neutral-950/92 text-white/85 backdrop-blur-md"
                  >
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault()
                        zoomBy(0.25)
                      }}
                      className="focus:bg-white/12 focus:text-white"
                    >
                      <Plus />
                      Zoom in
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault()
                        zoomBy(-0.25)
                      }}
                      className="focus:bg-white/12 focus:text-white"
                    >
                      <Minus />
                      Zoom out
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!hasMarks}
                      onSelect={() => clear()}
                      className="focus:bg-white/12 focus:text-white"
                    >
                      <Trash2 />
                      Clear all
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void handleDownload()}
                      className="focus:bg-white/12 focus:text-white"
                    >
                      <Download />
                      Download
                    </DropdownMenuItem>
                    {onSave && (
                      <DropdownMenuItem
                        disabled={saveState === "saving"}
                        onSelect={() => void handleSave()}
                        className="focus:bg-white/12 focus:text-white"
                      >
                        <Save />
                        {saveState === "saving"
                          ? "Saving…"
                          : "Save annotations"}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {drawingToolsGroup}
              {strokeSlider}
            </div>
            {tool === "text" && (
              <input
                aria-label="Annotation text"
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.08] px-3 text-sm text-white outline-none placeholder:text-white/45 focus:border-white/35"
                placeholder="Text"
              />
            )}
          </div>
        ) : (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-white/10 bg-black/35 px-2.5 py-2 backdrop-blur-md">
            {navigationGroup}

            {drawingToolsGroup}

            <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1.5">
              {COLORS.map((swatch) => (
                <SwatchButton
                  key={swatch}
                  color={swatch}
                  active={swatch === color}
                  onClick={() => chooseColor(swatch)}
                />
              ))}
              <span className="mx-0.5 h-5 w-px bg-white/12" />
              <CustomColorButton color={color} onChange={chooseColor} />
              <ToolButton
                label={
                  colorSampling
                    ? "Cancel color picker"
                    : "Pick color from image"
                }
                active={colorSampling}
                onClick={toggleColorSampling}
              >
                <Pipette className="size-4" />
              </ToolButton>
            </div>

            {strokeSlider}

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
              {onSave && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saveState === "saving"}
                      onClick={handleSave}
                      className="h-7 gap-1.5 rounded-md px-2 text-white/80 hover:bg-white/12 hover:text-white disabled:opacity-50"
                    >
                      <Save className="size-4" />
                      <span>{saveState === "saving" ? "Saving" : "Save"}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="z-[140]">
                    Save annotations
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        )}

        <div
          ref={viewportRef}
          className="relative min-h-0 flex-1 overflow-auto bg-black/25"
        >
          {/* w-max is load-bearing: with a plain min-w-full wrapper, a zoomed
              image overflows a centered flexbox on BOTH sides and the left
              half becomes unreachable (scroll coordinates cannot go negative). */}
          <div className="flex min-h-full w-max min-w-full items-center justify-center p-3">
            <div
              ref={cardRef}
              className="relative isolate overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/15"
              style={
                displayWidth && displayHeight
                  ? { width: displayWidth, height: displayHeight }
                  : undefined
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                src={imageUrl}
                alt={filename}
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget
                  setImageSize({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                  })
                }}
                className="block size-full bg-black object-contain select-none"
              />
              <canvas
                ref={canvasRef}
                aria-label="Image annotation canvas"
                className={cn(
                  "absolute inset-0 size-full touch-none",
                  cursorClass
                )}
                onPointerEnter={updateBrushPreviewFromPointer}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={finishPointer}
                onPointerLeave={(event) => {
                  hideBrushPreview()
                  const interaction = interactionRef.current
                  if (interaction && interaction.pointerId === event.pointerId)
                    finishPointer(event)
                }}
              />
              <div
                ref={brushPreviewNodeRef}
                className={cn(
                  "pointer-events-none absolute z-20",
                  !shouldShowBrushPreview && "hidden"
                )}
                style={{ left: 0, top: 0 }}
              >
                <span
                  className={cn(
                    "absolute rounded-full border shadow-[0_0_0_1px_rgba(0,0,0,0.82),0_0_0_2px_rgba(255,255,255,0.35)]",
                    tool === "eraser" && "border-dashed"
                  )}
                  style={{
                    width: brushPreviewSize,
                    height: brushPreviewSize,
                    transform: "translate(-50%, -50%)",
                    borderColor: brushPreviewBorder,
                    backgroundColor: brushPreviewFill,
                  }}
                />
                <span
                  className="absolute rounded-md border border-white/15 bg-black/70 px-1.5 py-0.5 text-[11px] leading-none font-medium text-white tabular-nums shadow-lg backdrop-blur-sm"
                  style={{ left: brushPreviewSize / 2 + 8, top: -10 }}
                >
                  {brushPreviewSize}px
                </span>
              </div>
            </div>
          </div>

          {(saveState === "saved" || saveState === "error" || exportError) && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-white/12 bg-black/72 px-3 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md">
              {saveState === "saved"
                ? "Saved"
                : (exportError ?? "Could not save")}
            </div>
          )}
        </div>

        {onSend && (
          <form
            className="shrink-0 border-t border-white/10 bg-black/45 px-3 py-2 backdrop-blur-md"
            onSubmit={(event) => {
              event.preventDefault()
              void handleSend()
            }}
          >
            <div className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-xl border border-white/12 bg-white/[0.08] px-2.5 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.22)]">
              <input
                value={sendText}
                onChange={(event) => {
                  setSendText(event.target.value)
                  if (sendState !== "sending") {
                    setSendState("idle")
                    setSendError(null)
                  }
                }}
                disabled={sendState === "sending"}
                placeholder="Add a message..."
                className="h-9 min-w-0 flex-1 bg-transparent px-1 text-sm text-white outline-none placeholder:text-white/45 disabled:opacity-60"
              />
              <Button
                type="submit"
                size="icon-lg"
                disabled={
                  sendDisabled ||
                  sendState === "sending" ||
                  imageSize.width <= 0 ||
                  imageSize.height <= 0
                }
                aria-label={
                  sendDisabled
                    ? (sendDisabledMessage ?? "Cannot send right now")
                    : "Send annotated image"
                }
                className="size-9 rounded-[11px] bg-white text-black hover:bg-white/90 disabled:opacity-45"
              >
                {sendState === "sending" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-[17px] stroke-[2.5]" />
                )}
              </Button>
            </div>
            {(sendError || (sendDisabled && sendDisabledMessage)) && (
              <div className="mx-auto mt-1.5 max-w-3xl px-1 text-xs font-medium text-white/70">
                {sendError ?? sendDisabledMessage}
              </div>
            )}
          </form>
        )}
      </div>
    </TooltipProvider>
  )
}
