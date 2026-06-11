import { Geist, Geist_Mono, Manrope } from "next/font/google"
import type { Metadata, Viewport } from "next"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import { SidebarProvider } from "@/components/ui/sidebar"
import { ChatStoreProvider } from "@/hooks/use-chat-store"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NotificationPermissionPrompt } from "@/components/notification-permission-prompt"
import { PreviewBasePathScript } from "@/components/preview-base-path-script"

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

const fontDisplay = Manrope({
  subsets: ["latin"],
  variable: "--font-display",
})

import { cookies } from "next/headers"

export const metadata: Metadata = {
  title: "Orchestrator",
  applicationName: "Orchestrator",
  description: "Orchestrator assistant workspace",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      {
        url: "/apple-touch-icon-precomposed.png",
        sizes: "180x180",
        type: "image/png",
      },
      {
        url: "/apple-touch-icon-180x180.png",
        sizes: "180x180",
        type: "image/png",
      },
      {
        url: "/apple-touch-icon-167x167.png",
        sizes: "167x167",
        type: "image/png",
      },
      {
        url: "/apple-touch-icon-152x152.png",
        sizes: "152x152",
        type: "image/png",
      },
      {
        url: "/apple-touch-icon-120x120.png",
        sizes: "120x120",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    title: "Orchestrator",
    // Translucent status bar so the installed PWA renders edge-to-edge behind
    // the clock/battery (immersive map, like Google Maps). Every view already
    // pads its top chrome by env(safe-area-inset-top), which only takes effect
    // with this style.
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-visual",
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" },
  ],
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const cookieStore = await cookies()
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false"

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        fontDisplay.variable,
        "font-sans",
        fontSans.variable
      )}
    >
      <body>
        <PreviewBasePathScript />
        <ThemeProvider>
          <TooltipProvider>
            <ChatStoreProvider>
              <SidebarProvider defaultOpen={defaultOpen}>
                {children}
                <NotificationPermissionPrompt />
              </SidebarProvider>
            </ChatStoreProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
