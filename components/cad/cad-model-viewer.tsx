"use client"

import * as React from "react"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { STLLoader } from "three/addons/loaders/STLLoader.js"
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js"
import { Grid3x3, Loader2, RotateCcw, Box, AlertTriangle, Play, Pause } from "lucide-react"

import { cn } from "@/lib/utils"
import type { CadModelFormat } from "@/components/cad/cad-model-format"

interface CadModelViewerProps {
    /** Fetchable URL of the model (same-origin workspace/upload API). */
    src: string
    format: CadModelFormat
    /** Known bounding box in mm (from the artifact). Shown as a size chip.
     *  When absent, dims are computed from geometry for mm-convention formats
     *  (stl/3mf) and hidden for glb (units not trustworthy). */
    dimensionsMm?: { x: number; y: number; z: number } | null
    className?: string
}

interface SceneHandle {
    resetView: () => void
    setGrid: (on: boolean) => void
    setWireframe: (on: boolean) => void
    setAutoRotate: (on: boolean) => void
}

const VIEW_DIR = new THREE.Vector3(1, 0.65, 1).normalize()

function disposeObject(root: THREE.Object3D) {
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = (mesh as THREE.Mesh).material
        if (Array.isArray(material)) material.forEach((m) => m.dispose())
        else if (material) material.dispose()
    })
}

function formatMm(v: number): string {
    return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
}

/**
 * Interactive 3D model viewer for CAD outputs (GLB/STL/3MF) — orbit, zoom,
 * pan, grid, wireframe. Used by the `application/vnd.ant.cad` artifact
 * renderer and the Library file preview. Read-only by design: this is a
 * "look at the part" surface, not an editor.
 *
 * Rendering is paused while the canvas is out of the viewport so several CAD
 * artifacts in one chat don't each burn a rAF loop.
 */
export function CadModelViewer({ src, format, dimensionsMm, className }: CadModelViewerProps) {
    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const handleRef = React.useRef<SceneHandle | null>(null)
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
    const [grid, setGridState] = React.useState(true)
    const [wireframe, setWireframeState] = React.useState(false)
    const [autoRotate, setAutoRotateState] = React.useState(false)
    const [computedDims, setComputedDims] = React.useState<{ x: number; y: number; z: number } | null>(null)

    React.useEffect(() => {
        const container = containerRef.current
        if (!container) return

        let disposed = false
        let frame = 0
        let visible = true
        let needsKick = true

        setStatus("loading")
        setErrorMessage(null)
        setComputedDims(null)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000)
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.1
        container.appendChild(renderer.domElement)
        renderer.domElement.style.display = "block"
        renderer.domElement.style.width = "100%"
        renderer.domElement.style.height = "100%"

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.08
        controls.autoRotateSpeed = 1.6
        controls.addEventListener("change", () => {
            needsKick = true
        })

        // Studio-ish neutral lighting that reads well on both themes.
        scene.add(new THREE.HemisphereLight(0xffffff, 0x665544, 1.1))
        const key = new THREE.DirectionalLight(0xffffff, 1.7)
        key.position.set(4, 8, 5)
        scene.add(key)
        const fill = new THREE.DirectionalLight(0xb8c8ff, 0.55)
        fill.position.set(-5, 2, -4)
        scene.add(fill)

        const modelGroup = new THREE.Group()
        scene.add(modelGroup)
        let gridHelper: THREE.GridHelper | null = null
        let fitRadius = 1
        let target = new THREE.Vector3()

        const resetView = () => {
            camera.position.copy(target.clone().addScaledVector(VIEW_DIR, fitRadius * 2.4))
            camera.near = Math.max(fitRadius / 500, 0.001)
            camera.far = fitRadius * 100
            camera.updateProjectionMatrix()
            controls.target.copy(target)
            controls.update()
            needsKick = true
        }

        const setMaterialFlag = (on: boolean) => {
            modelGroup.traverse((obj) => {
                const material = (obj as THREE.Mesh).material
                const mats = Array.isArray(material) ? material : material ? [material] : []
                for (const m of mats) {
                    if ("wireframe" in m) (m as THREE.MeshStandardMaterial).wireframe = on
                }
            })
            needsKick = true
        }

        handleRef.current = {
            resetView,
            setGrid: (on) => {
                if (gridHelper) gridHelper.visible = on
                needsKick = true
            },
            setWireframe: setMaterialFlag,
            setAutoRotate: (on) => {
                controls.autoRotate = on
                needsKick = true
            },
        }

        const resize = () => {
            const w = container.clientWidth
            const h = container.clientHeight
            if (w === 0 || h === 0) return
            renderer.setSize(w, h, false)
            camera.aspect = w / h
            camera.updateProjectionMatrix()
            needsKick = true
        }
        resize()
        const resizeObserver = new ResizeObserver(resize)
        resizeObserver.observe(container)

        // Pause the render loop while scrolled out of view.
        const io = new IntersectionObserver((entries) => {
            visible = entries[0]?.isIntersecting ?? true
            needsKick = true
        })
        io.observe(container)

        const renderLoop = () => {
            frame = requestAnimationFrame(renderLoop)
            if (!visible) return
            const damping = controls.update()
            if (damping || controls.autoRotate || needsKick) {
                needsKick = false
                renderer.render(scene, camera)
            }
        }

        const onLoaded = (object: THREE.Object3D, upAxis: "y" | "z") => {
            if (disposed) {
                disposeObject(object)
                return
            }
            // CAD exports (STL/3MF, and cadpy GLB before Y-up conversion) are
            // Z-up; three is Y-up. Wrap so the part stands on the grid.
            if (upAxis === "z") object.rotation.x = -Math.PI / 2
            modelGroup.add(object)

            const box = new THREE.Box3().setFromObject(modelGroup)
            const size = box.getSize(new THREE.Vector3())
            const center = box.getCenter(new THREE.Vector3())
            const maxDim = Math.max(size.x, size.y, size.z) || 1

            // Rest the part on y=0 and center it on the grid.
            modelGroup.position.set(-center.x, -box.min.y, -center.z)
            target = new THREE.Vector3(0, size.y / 2, 0)
            fitRadius = maxDim

            const gridSize = maxDim * 2.4
            gridHelper = new THREE.GridHelper(gridSize, 20, 0x8a93a6, 0x8a93a6)
            const gridMaterial = gridHelper.material as THREE.Material
            gridMaterial.transparent = true
            gridMaterial.opacity = 0.22
            gridHelper.visible = grid
            scene.add(gridHelper)

            // Size chip: trust explicit dims; otherwise compute only for
            // mm-convention formats (GLB units vary by exporter).
            if (!dimensionsMm && format !== "glb") {
                setComputedDims({ x: size.x, y: size.z, z: size.y })
            }

            setMaterialFlag(wireframe)
            controls.autoRotate = autoRotate
            resetView()
            setStatus("ready")
        }

        const onError = (err: unknown) => {
            if (disposed) return
            console.error("CAD model load failed:", err)
            setErrorMessage(err instanceof Error ? err.message : "failed to load model")
            setStatus("error")
        }

        const defaultMaterial = () =>
            new THREE.MeshStandardMaterial({ color: 0x9db4d0, metalness: 0.15, roughness: 0.55 })

        if (format === "glb") {
            new GLTFLoader().load(src, (gltf) => onLoaded(gltf.scene, "y"), undefined, onError)
        } else if (format === "stl") {
            new STLLoader().load(
                src,
                (geometry) => {
                    geometry.computeVertexNormals()
                    onLoaded(new THREE.Mesh(geometry, defaultMaterial()), "z")
                },
                undefined,
                onError
            )
        } else {
            new ThreeMFLoader().load(
                src,
                (object) => {
                    // 3MF parts frequently arrive with flat/no materials; give
                    // bare meshes the default CAD material.
                    object.traverse((obj) => {
                        const mesh = obj as THREE.Mesh
                        if (mesh.isMesh && !mesh.material) mesh.material = defaultMaterial()
                    })
                    onLoaded(object, "z")
                },
                undefined,
                onError
            )
        }

        renderLoop()

        return () => {
            disposed = true
            cancelAnimationFrame(frame)
            resizeObserver.disconnect()
            io.disconnect()
            controls.dispose()
            disposeObject(scene)
            if (gridHelper) {
                gridHelper.geometry.dispose()
                ;(gridHelper.material as THREE.Material).dispose()
            }
            renderer.dispose()
            renderer.domElement.remove()
            handleRef.current = null
        }
        // Rebuild the scene only when the model itself changes; toggles go
        // through handleRef without a teardown.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, format])

    const dims = dimensionsMm ?? computedDims

    return (
        <div className={cn("group relative h-full w-full overflow-hidden", className)}>
            <div ref={containerRef} className="absolute inset-0" />

            {status === "loading" && (
                <div className="absolute inset-0 flex items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
            )}

            {status === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <AlertTriangle className="size-6 text-destructive" />
                    <p className="text-sm font-medium">Could not load the 3D model</p>
                    {errorMessage && <p className="max-w-full truncate text-xs text-muted-foreground">{errorMessage}</p>}
                </div>
            )}

            {status === "ready" && dims && (
                <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-background/70 px-2 py-1 text-[11px] tabular-nums text-muted-foreground backdrop-blur-sm">
                    {formatMm(dims.x)} × {formatMm(dims.y)} × {formatMm(dims.z)} mm
                </div>
            )}

            {status === "ready" && (
                <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-lg bg-background/70 p-1 backdrop-blur-sm">
                    <ViewerButton label="Reset view" onClick={() => handleRef.current?.resetView()}>
                        <RotateCcw className="size-3.5" />
                    </ViewerButton>
                    <ViewerButton
                        label={grid ? "Hide grid" : "Show grid"}
                        active={grid}
                        onClick={() => {
                            setGridState((v) => {
                                handleRef.current?.setGrid(!v)
                                return !v
                            })
                        }}
                    >
                        <Grid3x3 className="size-3.5" />
                    </ViewerButton>
                    <ViewerButton
                        label={wireframe ? "Solid" : "Wireframe"}
                        active={wireframe}
                        onClick={() => {
                            setWireframeState((v) => {
                                handleRef.current?.setWireframe(!v)
                                return !v
                            })
                        }}
                    >
                        <Box className="size-3.5" />
                    </ViewerButton>
                    <ViewerButton
                        label={autoRotate ? "Stop rotation" : "Auto-rotate"}
                        active={autoRotate}
                        onClick={() => {
                            setAutoRotateState((v) => {
                                handleRef.current?.setAutoRotate(!v)
                                return !v
                            })
                        }}
                    >
                        {autoRotate ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                    </ViewerButton>
                </div>
            )}
        </div>
    )
}

function ViewerButton({
    label,
    active,
    onClick,
    children,
}: {
    label: string
    active?: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            aria-pressed={active}
            className={cn(
                "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                active && "bg-muted text-foreground"
            )}
        >
            {children}
        </button>
    )
}

export default CadModelViewer
