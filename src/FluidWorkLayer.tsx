import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { SettingsDialog } from "./SettingsControls";
import {FluidWorkLayerArrival} from './fluid/FluidWorkLayerArrival';

/** One user-opened work surface above the persistent main conversation.
 * Changing its size keeps the same dialog and child tree mounted. */
export function FluidWorkLayer({ title, onClose, children, className = "", initialMaximized = false, eyebrow, open = true }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  initialMaximized?: boolean;
  eyebrow?: string;
  open?: boolean;
}) {
  const [maximized, setMaximized] = useState(initialMaximized);
  const SizeIcon = maximized ? Minimize2 : Maximize2;
  return <SettingsDialog title={title} eyebrow={eyebrow} open={open} onClose={onClose}
    className={`fluid-work-layer fluid-formal-work-layer${maximized ? " is-maximized" : ""}${className ? ` ${className}` : ""}`}
    headerActions={<button type="button" className="settings-icon-button fluid-layer-size-button" aria-label={maximized ? "还原工作面板" : "放大工作面板"} title={maximized ? "还原工作面板" : "放大工作面板"} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}><SizeIcon size={17}/></button>}>
    <FluidWorkLayerArrival open={open}/>{children}
  </SettingsDialog>;
}
