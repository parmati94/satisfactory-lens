import { Parser } from '@etothepii/satisfactory-file-parser';

// Use inferred type from the parser return
type SatisfactorySave = ReturnType<typeof Parser.ParseSave>;

interface SaveState {
  save: SatisfactorySave | null;
  loadedAt: Date | null;
  sourceName: string | null;
  sourceMtimeMs: number | null;
  sourceSaveDateTime: string | null;
  error: string | null;
  loading: boolean;
}

const state: SaveState = {
  save: null,
  loadedAt: null,
  sourceName: null,
  sourceMtimeMs: null,
  sourceSaveDateTime: null,
  error: null,
  loading: false,
};

export function getSave(): SatisfactorySave | null {
  return state.save;
}

export function getSaveStatus() {
  return {
    loaded: state.save !== null,
    loadedAt: state.loadedAt?.toISOString() ?? null,
    sourceName: state.sourceName,
    error: state.error,
    loading: state.loading,
  };
}

/** mtime (ms) of the on-disk file backing the currently loaded save, if loaded from the mount. */
export function getLoadedSourceMtimeMs(): number | null {
  return state.sourceMtimeMs;
}

/** saveDateTime of the currently loaded save, if loaded via the SF API's resolved-latest path. */
export function getLoadedSourceSaveDateTime(): string | null {
  return state.sourceSaveDateTime;
}

export function setSave(
  save: SatisfactorySave,
  sourceName: string,
  sourceMtimeMs: number | null = null,
  sourceSaveDateTime: string | null = null,
): void {
  state.save = save;
  state.loadedAt = new Date();
  state.sourceName = sourceName;
  state.sourceMtimeMs = sourceMtimeMs;
  state.sourceSaveDateTime = sourceSaveDateTime;
  state.error = null;
  state.loading = false;
}

export function setSaveError(error: string): void {
  state.save = null;
  state.error = error;
  state.loading = false;
}

export function setSaveLoading(loading: boolean): void {
  state.loading = loading;
}

export function clearSave(): void {
  state.save = null;
  state.loadedAt = null;
  state.sourceName = null;
  state.sourceMtimeMs = null;
  state.sourceSaveDateTime = null;
  state.error = null;
  state.loading = false;
}
