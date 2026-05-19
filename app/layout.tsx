import { Geist, Geist_Mono, Manrope } from "next/font/google"
import type { Metadata, Viewport } from "next"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import { SidebarProvider } from "@/components/ui/sidebar"
import { ChatStoreProvider } from "@/hooks/use-chat-store"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NotificationPermissionPrompt } from "@/components/notification-permission-prompt"

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
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    title: "Orchestrator",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
