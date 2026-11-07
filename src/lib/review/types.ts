export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number }
export interface FileHunks { path: string; oldPath: string | null; hunks: Hunk[] }
