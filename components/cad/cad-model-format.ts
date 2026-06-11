export type CadModelFormat = "glb" | "stl" | "3mf"

/** Pick the 3D loader format from a filename/path. Returns null when the
 *  extension is not a renderable mesh format. Lives apart from the viewer so
 *  routing code can import it without pulling three.js into its bundle. */
export function cadModelFormatFor(pathOrName: string): CadModelFormat | null {
    const ext = pathOrName.split(".").pop()?.toLowerCase() ?? ""
    if (ext === "glb") return "glb"
    if (ext === "stl") return "stl"
    if (ext === "3mf") return "3mf"
    return null
}
