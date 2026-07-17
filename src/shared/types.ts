export type SettingType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'inline_richtext'
  | 'url'
  | 'image_picker'
  | 'video'
  | 'video_url'
  | 'color'
  | 'color_background'
  | 'range'
  | 'checkbox'
  | 'select'
  | 'text_alignment'
  | 'product'
  | 'collection';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDefinition {
  type: SettingType;
  id: string;
  label: string;
  default?: string | number | boolean;
  info?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: SettingOption[];
  accept?: Array<'youtube' | 'vimeo'>;
  visible_if?: string;
}

export interface SidebarDefinition {
  type: 'header' | 'paragraph';
  content: string;
  visible_if?: string;
}

export type EditorEntry = SettingDefinition | SidebarDefinition;

export interface BlockDefinition {
  type: string;
  name: string;
  limit?: number;
  settings: EditorEntry[];
}

export interface PresetBlock {
  type: string;
  settings?: Record<string, string | number | boolean>;
}

export interface SectionPreset {
  name: string;
  category?: string;
  settings?: Record<string, string | number | boolean>;
  blocks?: PresetBlock[];
}

export interface SectionSource {
  liquid: string;
  css: string;
  javascript?: string;
}

export interface SectionManifest {
  contractVersion: 1;
  name: string;
  handle: string;
  description: string;
  tag?: 'section' | 'div' | 'aside' | 'header' | 'footer';
  className?: string;
  limit?: 1 | 2;
  maxBlocks?: number;
  enabledTemplates?: string[];
  settings: EditorEntry[];
  blocks: BlockDefinition[];
  presets: SectionPreset[];
  source: SectionSource;
}

export interface GeneratedFile {
  path: string;
  content: string;
  language: 'liquid' | 'css' | 'javascript' | 'json' | 'markdown';
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface CompileResult {
  valid: boolean;
  files: GeneratedFile[];
  issues: ValidationIssue[];
  stats: {
    settings: number;
    blockTypes: number;
    liquidBytes: number;
    cssBytes: number;
    javascriptBytes: number;
  };
}

export interface HeroBuilderState {
  name: string;
  handle: string;
  eyebrow: string;
  heading: string;
  body: string;
  primaryLabel: string;
  primaryUrl: string;
  secondaryLabel: string;
  secondaryUrl: string;
  backgroundType: 'color' | 'gradient' | 'image' | 'video';
  backgroundColor: string;
  gradient: string;
  previewImageUrl: string;
  overlayColor: string;
  overlayOpacity: number;
  textColor: string;
  accentColor: string;
  contentPosition: 'top-left' | 'top-center' | 'center-left' | 'center' | 'bottom-left' | 'bottom-center';
  textAlignment: 'left' | 'center' | 'right';
  sectionHeight: number;
  contentWidth: number;
  headingSize: number;
  mobileHeadingSize: number;
  paddingX: number;
  paddingY: number;
  animation: 'none' | 'fade-up' | 'reveal' | 'blur-in';
  animationDuration: number;
  parallax: boolean;
}
