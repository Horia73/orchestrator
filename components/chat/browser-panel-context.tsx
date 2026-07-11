"use client"

import * as React from "react"

export interface BrowserPanelState {
  /**
   * runId of the browser_agent run currently hosted by the desktop side
   * panel, or null. While a run is in the panel, its inline message block
   * collapses to a chip instead of mounting a second live-view connection.
   */
  panelRunId: string | null
}

const BrowserPanelContext = React.createContext<BrowserPanelState>({
  panelRunId: null,
})

export function BrowserPanelProvider({
  panelRunId,
  children,
}: {
  panelRunId: string | null
  children: React.ReactNode
}) {
  const value = React.useMemo(() => ({ panelRunId }), [panelRunId])
  return (
    <BrowserPanelContext.Provider value={value}>
      {children}
    </BrowserPanelContext.Provider>
  )
}

export function useBrowserPanelState(): BrowserPanelState {
  return React.useContext(BrowserPanelContext)
}
