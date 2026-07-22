import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { PdfViewer } from "../components/pdf-viewer"
import { computeMobileKeyboardInset } from "../hooks/use-keyboard-inset"

// iOS can shrink innerHeight/clientHeight together with visualViewport. The
// hook retains the closed 844px baseline while the editor is focused, so the
// shared 520px shrunken value still resolves to the real keyboard inset.
assert.equal(computeMobileKeyboardInset(844, 520), 324)

// Small browser-toolbar changes are not a software keyboard.
assert.equal(computeMobileKeyboardInset(844, 780), 0)

// Invalid or closed viewport samples fail safe.
assert.equal(computeMobileKeyboardInset(844, 844), 0)
assert.equal(computeMobileKeyboardInset(0, 520), 0)
assert.equal(computeMobileKeyboardInset(Number.NaN, 520), 0)

// The first PDF paint is responsive in CSS: phones receive a zero-width rail
// and the open-rail icon, while desktop restores the 9rem rail without waiting
// for a client effect (which would cause a visible hydration swap).
const pdfMarkup = renderToStaticMarkup(
  React.createElement(PdfViewer, {
    url: "/sample.pdf",
    filename: "sample.pdf",
    onClose: () => undefined,
  })
)
assert.match(pdfMarkup, /w-0 md:w-36 md:border-r md:border-pdf-border/)
assert.match(pdfMarkup, /lucide-panel-left-open size-4 md:hidden/)

console.log("mobile keyboard inset smoke passed")
