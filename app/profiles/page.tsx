import * as React from "react"

import { ProfilePicker } from "@/components/profiles/profile-picker"

export default function ProfilesPage() {
  return (
    <React.Suspense fallback={null}>
      <ProfilePicker />
    </React.Suspense>
  )
}
