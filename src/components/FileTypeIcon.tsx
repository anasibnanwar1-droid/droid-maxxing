import {
  File,
  FileArchive,
  FileCog,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import {
  SiCss,
  SiDocker,
  SiDotenv,
  SiGnubash,
  SiHtml5,
  SiJavascript,
  SiJson,
  SiMarkdown,
  SiNpm,
  SiPython,
  SiReact,
  SiRust,
  SiTypescript,
} from 'react-icons/si';
import type { AriaAttributes } from 'react';
import { resolveFilePresentation, type FilePresentationKind } from '../lib/filePresentation';

export interface FileTypeIconProps extends Pick<AriaAttributes, 'aria-hidden' | 'aria-label'> {
  filename: string;
  isDirectory?: boolean;
  expanded?: boolean;
  className?: string;
}

const KIND_STYLES: Record<FilePresentationKind, string> = {
  react: 'text-droid-accent',
  typescript: 'text-droid-accent',
  javascript: 'text-droid-orange',
  json: 'text-droid-orange',
  css: 'text-droid-accent',
  html: 'text-droid-orange',
  markdown: 'text-droid-text-secondary',
  python: 'text-droid-accent',
  rust: 'text-droid-orange',
  shell: 'text-droid-green',
  docker: 'text-droid-accent',
  package: 'text-droid-red',
  config: 'text-droid-text-muted',
  env: 'text-droid-orange',
  image: 'text-droid-accent',
  pdf: 'text-droid-red',
  document: 'text-droid-accent',
  spreadsheet: 'text-droid-green',
  archive: 'text-droid-orange',
  unknown: 'text-droid-text-muted',
};

function iconForKind(kind: FilePresentationKind) {
  switch (kind) {
    case 'react':
      return SiReact;
    case 'typescript':
      return SiTypescript;
    case 'javascript':
      return SiJavascript;
    case 'json':
      return SiJson;
    case 'css':
      return SiCss;
    case 'html':
      return SiHtml5;
    case 'markdown':
      return SiMarkdown;
    case 'python':
      return SiPython;
    case 'rust':
      return SiRust;
    case 'shell':
      return SiGnubash;
    case 'docker':
      return SiDocker;
    case 'package':
      return SiNpm;
    case 'env':
      return SiDotenv;
    case 'config':
      return FileCog;
    case 'image':
      return FileImage;
    case 'spreadsheet':
      return FileSpreadsheet;
    case 'archive':
      return FileArchive;
    case 'pdf':
    case 'document':
      return FileText;
    case 'unknown':
      return File;
  }
}

export function FileTypeIcon({
  filename,
  isDirectory = false,
  expanded = false,
  className,
  'aria-hidden': ariaHidden = true,
  'aria-label': ariaLabel,
}: FileTypeIconProps) {
  const presentation = resolveFilePresentation(filename);
  const kind = isDirectory ? 'unknown' : presentation.kind;
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : iconForKind(kind);
  const sizeClasses = className ? '' : 'h-4 w-4';
  const colorClass = isDirectory ? 'text-droid-text-muted' : KIND_STYLES[kind];

  return (
    <Icon
      className={`${sizeClasses} shrink-0 ${colorClass} ${className ?? ''}`.trim()}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : (ariaLabel ?? filename)}
      role={ariaHidden ? undefined : 'img'}
    />
  );
}
