import { useCallback, useEffect, useRef, useState } from "react";
import { browseProject } from "../lib/api";
import type { BrowseDirectory, ProjectConfig } from "../lib/types";

type Props = {
  token: string;
  projects: ProjectConfig[];
  selectedProjectId?: string;
  selectedSubpath?: string;
  onSelect: (projectId: string, subpath?: string, workingDirectoryId?: string) => void;
};

function buildBreadcrumbs(subpath: string): { label: string; subpath: string }[] {
  if (!subpath) return [];
  const parts = subpath.split("/");
  return parts.map((part, i) => ({
    label: part,
    subpath: parts.slice(0, i + 1).join("/")
  }));
}

export function ProjectSelector({ token, projects, selectedProjectId, selectedSubpath, onSelect }: Props) {
  const [browsingProjectId, setBrowsingProjectId] = useState<string | null>(null);
  const [currentSubpath, setCurrentSubpath] = useState("");
  const [canonicalSubpath, setCanonicalSubpath] = useState("");
  const [currentWorkingDirectoryId, setCurrentWorkingDirectoryId] = useState("");
  const [directories, setDirectories] = useState<BrowseDirectory[]>([]);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string>();

  const abortControllerRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef<number>(0);

  const browsingProject = projects.find((p) => p.id === browsingProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const navigateTo = useCallback(
    async (projectId: string, subpath: string) => {
      // Abort previous in-flight request
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      sequenceRef.current += 1;
      const currentSeq = sequenceRef.current;

      setLoading(true);
      setBrowseError(undefined);

      try {
        const result = await browseProject(token, projectId, subpath || undefined, {
          signal: controller.signal
        });

        // Ignore out-of-order response
        if (sequenceRef.current !== currentSeq) return;

        setBrowsingProjectId(projectId);
        setCurrentSubpath(subpath);
        setCanonicalSubpath(result.canonicalSubpath ?? subpath);
        setCurrentWorkingDirectoryId(result.workingDirectoryId ?? "");
        setDirectories(result.directories);
      } catch (err) {
        if (sequenceRef.current !== currentSeq) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setBrowseError(err instanceof Error ? err.message : "Không tải được danh sách thư mục.");
      } finally {
        if (sequenceRef.current === currentSeq) {
          setLoading(false);
        }
      }
    },
    [token]
  );

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const resetBrowse = () => {
    abortControllerRef.current?.abort();
    setBrowsingProjectId(null);
    setDirectories([]);
    setCurrentSubpath("");
    setCanonicalSubpath("");
    setCurrentWorkingDirectoryId("");
    setBrowseError(undefined);
    setLoading(false);
  };

  const selectedDisplay = selectedProject
    ? selectedSubpath
      ? `${selectedProject.label}/${selectedSubpath}`
      : selectedProject.label
    : null;

  if (!browsingProjectId) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-zinc-300">Chọn thư mục dự án</p>

        {selectedDisplay ? (
          <div className="flex items-center gap-2 border border-signal-400/30 bg-signal-500/5 px-3 py-2 text-xs text-signal-300">
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            <span className="truncate">{selectedDisplay}</span>
          </div>
        ) : null}

        <div className="max-h-64 overflow-y-auto border border-white/10 bg-shell-800">
          {projects.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-zinc-500">Chưa có project trong allowlist</div>
          ) : (
            projects.map((project) => {
              const isSelected = project.id === selectedProjectId && !selectedSubpath;
              return (
                <div
                  key={project.id}
                  className={`flex items-center border-b border-white/5 last:border-b-0 ${
                    isSelected ? "border-l-2 border-l-signal-400 bg-signal-500/10" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(project.id, undefined, project.workingDirectoryId)}
                    className="flex min-h-12 flex-1 items-center gap-2 px-3 text-left active:bg-white/10"
                  >
                    <svg className="h-4 w-4 shrink-0 text-signal-400" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-100">{project.label}</p>
                      <p className="truncate text-xs text-zinc-500">Project được server cho phép</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateTo(project.id, "")}
                    className="flex h-12 w-12 shrink-0 items-center justify-center text-zinc-500 active:bg-white/10 active:text-zinc-200"
                    title="Duyệt thư mục con"
                    aria-label={`Duyệt thư mục con của ${project.label}`}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  const breadcrumbs = buildBreadcrumbs(currentSubpath);

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-300">Chọn thư mục dự án</p>

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={resetBrowse}
          className="min-h-11 px-2 text-signal-400 active:text-signal-300"
        >
          Tất cả
        </button>
        <span className="text-zinc-600">/</span>
        <button
          type="button"
          onClick={() => navigateTo(browsingProjectId, "")}
          className={`min-h-11 px-2 ${currentSubpath ? "text-signal-400 active:text-signal-300" : "text-zinc-300"}`}
        >
          {browsingProject?.label}
        </button>
        {breadcrumbs.map((crumb) => {
          const isLast = crumb.subpath === currentSubpath;
          return (
            <span key={crumb.subpath} className="flex items-center gap-1">
              <span className="text-zinc-600">/</span>
              {isLast ? (
                <span className="text-zinc-300">{crumb.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateTo(browsingProjectId, crumb.subpath)}
                  className="min-h-11 break-all px-2 text-signal-400 active:text-signal-300"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Select current directory button - disabled when loading or error */}
      <button
        type="button"
        disabled={loading || Boolean(browseError)}
        onClick={() => {
          onSelect(browsingProjectId, canonicalSubpath || currentSubpath || undefined, currentWorkingDirectoryId);
          resetBrowse();
        }}
        className="flex min-h-10 w-full items-center justify-center gap-2 bg-signal-500 text-sm font-bold text-black active:bg-signal-400 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
        {loading ? "Đang tải…" : "Chọn thư mục này"}
      </button>

      {/* Directory listing */}
      <div className="max-h-64 overflow-y-auto border border-white/10 bg-shell-800">
        {loading ? (
          <div className="flex items-center justify-center px-3 py-4 text-sm text-zinc-500">
            <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Đang tải...
          </div>
        ) : browseError ? (
          <div className="px-3 py-4 text-center text-sm text-red-400">
            <p>{browseError}</p>
            <button
              type="button"
              onClick={() => navigateTo(browsingProjectId, currentSubpath)}
              className="mt-2 text-xs text-signal-400 underline"
            >
              Thử lại
            </button>
          </div>
        ) : directories.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-zinc-500">Không có thư mục con</div>
        ) : (
          directories.map((dir) => (
            <button
              key={dir.subpath}
              type="button"
              onClick={() => navigateTo(browsingProjectId, dir.subpath)}
              className="flex min-h-11 w-full items-center gap-2 border-b border-white/5 px-3 text-left last:border-b-0 active:bg-white/10"
            >
              <svg className="h-4 w-4 shrink-0 text-zinc-500" viewBox="0 0 20 20" fill="currentColor">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
              <span className="flex-1 truncate text-sm text-zinc-200">{dir.name}</span>
              <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
