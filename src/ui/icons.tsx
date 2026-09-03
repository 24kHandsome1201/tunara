import type { CSSProperties } from "react";
import type { Icon as PhosphorIcon, IconProps as PhosphorIconProps, IconWeight } from "@phosphor-icons/react/lib";
import { AlignLeftSimple } from "@phosphor-icons/react/dist/ssr/AlignLeftSimple";
import { AppWindow } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { ArrowClockwise } from "@phosphor-icons/react/dist/ssr/ArrowClockwise";
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/ssr/ArrowCounterClockwise";
import { ArrowDown } from "@phosphor-icons/react/dist/ssr/ArrowDown";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { ArrowUp } from "@phosphor-icons/react/dist/ssr/ArrowUp";
import { ArrowsDownUp } from "@phosphor-icons/react/dist/ssr/ArrowsDownUp";
import { BellSimple } from "@phosphor-icons/react/dist/ssr/BellSimple";
import { BookmarkSimple } from "@phosphor-icons/react/dist/ssr/BookmarkSimple";
import { CaretDown } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { CaretLeft } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { CaretUp } from "@phosphor-icons/react/dist/ssr/CaretUp";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { ClipboardText } from "@phosphor-icons/react/dist/ssr/ClipboardText";
import { CopySimple } from "@phosphor-icons/react/dist/ssr/CopySimple";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr/DownloadSimple";
import { File } from "@phosphor-icons/react/dist/ssr/File";
import { FileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { FolderSimple } from "@phosphor-icons/react/dist/ssr/FolderSimple";
import { FolderSimplePlus } from "@phosphor-icons/react/dist/ssr/FolderSimplePlus";
import { Gear } from "@phosphor-icons/react/dist/ssr/Gear";
import { HardDrives } from "@phosphor-icons/react/dist/ssr/HardDrives";
import { List } from "@phosphor-icons/react/dist/ssr/List";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { Minus } from "@phosphor-icons/react/dist/ssr/Minus";
import { MinusCircle } from "@phosphor-icons/react/dist/ssr/MinusCircle";
import { NotePencil } from "@phosphor-icons/react/dist/ssr/NotePencil";
import { PencilSimple } from "@phosphor-icons/react/dist/ssr/PencilSimple";
import { Play } from "@phosphor-icons/react/dist/ssr/Play";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { PushPin } from "@phosphor-icons/react/dist/ssr/PushPin";
import { ShareNetwork } from "@phosphor-icons/react/dist/ssr/ShareNetwork";
import { SidebarSimple } from "@phosphor-icons/react/dist/ssr/SidebarSimple";
import { Square } from "@phosphor-icons/react/dist/ssr/Square";
import { SquareSplitHorizontal } from "@phosphor-icons/react/dist/ssr/SquareSplitHorizontal";
import { SquareSplitVertical } from "@phosphor-icons/react/dist/ssr/SquareSplitVertical";
import { Terminal } from "@phosphor-icons/react/dist/ssr/Terminal";
import { TerminalWindow } from "@phosphor-icons/react/dist/ssr/TerminalWindow";
import { TextT } from "@phosphor-icons/react/dist/ssr/TextT";
import { TrashSimple } from "@phosphor-icons/react/dist/ssr/TrashSimple";
import { UploadSimple } from "@phosphor-icons/react/dist/ssr/UploadSimple";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { X } from "@phosphor-icons/react/dist/ssr/X";

export type { IconWeight };
export type IconGlyph = PhosphorIcon;

type IconPassthrough = Omit<PhosphorIconProps, "alt" | "color" | "size" | "weight">;

export interface IconProps extends IconPassthrough {
  icon: IconGlyph;
  size?: number;
  weight?: IconWeight;
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** Accessible name. When set, the glyph is exposed to AT; otherwise it is aria-hidden. */
  label?: string;
}

/**
 * App-wide Phosphor glyph. Chrome defaults: regular weight, 16px, currentColor,
 * aria-hidden. Pass `label` for a standalone meaningful icon. Use `bold` for
 * 10–12px carets and other tiny glyphs so the stroke still reads.
 */
export function Icon({
  icon: Glyph,
  size = 16,
  weight = "regular",
  color,
  className,
  style,
  label,
  ...rest
}: IconProps) {
  return (
    <Glyph
      size={size}
      weight={weight}
      color={color}
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      {...rest}
    />
  );
}

function tinyWeight(size: number, strokeWidth?: number): IconWeight {
  if (size <= 12 || (strokeWidth ?? 0) >= 2.4) return "bold";
  return "regular";
}

export function CloseIcon({
  size = 13,
  strokeWidth,
  color = "currentColor",
}: {
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  return <Icon icon={X} size={size} color={color} weight={tinyWeight(size, strokeWidth)} />;
}

export function SearchIcon({ size = 13, color = "var(--c-text-5)" }: { size?: number; color?: string }) {
  return <Icon icon={MagnifyingGlass} size={size} color={color} />;
}

export function RefreshIcon({ size = 13 }: { size?: number }) {
  return <Icon icon={ArrowClockwise} size={size} weight={size <= 12 ? "bold" : "regular"} />;
}

export function UploadIcon({ size = 14 }: { size?: number }) {
  return <Icon icon={UploadSimple} size={size} />;
}

export function UploadFolderIcon({ size = 14 }: { size?: number }) {
  return <Icon icon={FolderSimplePlus} size={size} />;
}

export function DownloadIcon({ size = 14 }: { size?: number }) {
  return <Icon icon={DownloadSimple} size={size} />;
}

export function RestartIcon({ size = 10 }: { size?: number }) {
  return <Icon icon={ArrowClockwise} size={size} weight="bold" />;
}

export function ResumeIcon({ size = 9 }: { size?: number }) {
  return <Icon icon={Play} size={size} weight="bold" />;
}

export function FolderIcon({ size = 16, color = "var(--c-text-4)" }: { size?: number; color?: string }) {
  return <Icon icon={FolderSimple} size={size} color={color} />;
}

export function FileIcon({ size = 16, color = "var(--c-text-5)" }: { size?: number; color?: string }) {
  return <Icon icon={File} size={size} color={color} />;
}

export function FileNameIcon({ size = 13 }: { size?: number }) {
  return <Icon icon={FileText} size={size} />;
}

export function FileContentIcon({ size = 13 }: { size?: number }) {
  return <Icon icon={AlignLeftSimple} size={size} />;
}

export function TreeChevron({ expanded = false }: { expanded?: boolean }) {
  return (
    <Icon
      icon={CaretRight}
      className="explorer-tree-chevron"
      data-expanded={expanded ? "true" : "false"}
      size={10}
      weight="bold"
    />
  );
}

export const folderEmptyIcon = <Icon icon={FolderSimple} size={16} />;

export function PanelEmptyGlyph() {
  return <Icon icon={MinusCircle} size={16} />;
}

export function PanelErrorGlyph() {
  return <Icon icon={Warning} size={16} />;
}

export {
  AlignLeftSimple,
  AppWindow,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowUp,
  ArrowsDownUp,
  BellSimple,
  BookmarkSimple,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  ClipboardText,
  CopySimple,
  DownloadSimple,
  File,
  FileText,
  FolderSimple,
  FolderSimplePlus,
  Gear,
  HardDrives,
  List,
  MagnifyingGlass,
  Minus,
  MinusCircle,
  NotePencil,
  PencilSimple,
  Play,
  Plus,
  PushPin,
  ShareNetwork,
  SidebarSimple,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Terminal,
  TerminalWindow,
  TextT,
  TrashSimple,
  UploadSimple,
  Warning,
  X,
};
