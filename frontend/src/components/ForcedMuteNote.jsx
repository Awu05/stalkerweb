import { VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Over the picture while the browser, not the viewer, has it muted (lib/forcedMute.js). */
export default function ForcedMuteNote({ className }) {
  return (
    <div role="status" className={cn('absolute top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/75 backdrop-blur-sm text-white text-xs shadow-lg pointer-events-none whitespace-nowrap', className)}>
      <VolumeX size={14} aria-hidden />
      <span>Muted by your browser — click anywhere or press a key for sound</span>
    </div>
  )
}
