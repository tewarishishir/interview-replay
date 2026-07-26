"use client";

import {
  ChevronDown,
  GripVertical,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useId, useState, type DragEvent, type FormEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PROFILE_LIMITS } from "@/lib/profiles/constants";
import {
  ApiError,
  deleteProject,
  patchProject,
  postProject,
  reorderProjects,
} from "@/lib/profiles/api-client";
import type { ProjectDto } from "@/lib/profiles/dto";
import { cn } from "@/lib/utils";

interface ProjectsSectionProps {
  projects: ProjectDto[];
  onChange: (next: ProjectDto[]) => void;
}

/**
 * Section 2: Projects (3-5 strongest).
 *
 * - Each project rendered as a collapsible card with inline edit.
 * - Drag handles reorder via PATCH /api/projects/reorder.
 * - Delete is two-click (Trash2 → "Are you sure?" inline confirm).
 * - "Add project" reveals an inline form at the bottom.
 * - Recommendation banner appears when count < 3.
 */
export function ProjectsSection({ projects, onChange }: ProjectsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleReorder(nextIds: string[]) {
    setReorderError(null);
    setBusy(true);
    // Optimistic update.
    const optimistic = nextIds
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is ProjectDto => Boolean(p));
    onChange(optimistic);
    try {
      const { projects: persisted } = await reorderProjects(nextIds);
      onChange(persisted);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Could not save the new order.";
      setReorderError(msg);
      // Roll back to server-truth.
      onChange(projects);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {projects.length < PROFILE_LIMITS.projectsRecommendedMin ? (
        <Alert>
          <AlertTitle>Add a few more</AlertTitle>
          <AlertDescription>
            Add at least {PROFILE_LIMITS.projectsRecommendedMin} projects for
            the best feedback.
          </AlertDescription>
        </Alert>
      ) : null}

      {reorderError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t save the new order</AlertTitle>
          <AlertDescription>{reorderError}</AlertDescription>
        </Alert>
      ) : null}

      <ProjectList
        projects={projects}
        onChange={onChange}
        onReorder={handleReorder}
        disabled={busy}
      />

      {!adding && projects.length < PROFILE_LIMITS.projectsMax ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-4" aria-hidden /> Add project
          </Button>
        </div>
      ) : null}

      {projects.length >= PROFILE_LIMITS.projectsMax ? (
        <p className="text-xs text-muted-foreground">
          You&apos;ve hit the {PROFILE_LIMITS.projectsMax}-project cap.
          Delete one to add another.
        </p>
      ) : null}

      {adding ? (
        <ProjectForm
          mode="create"
          onSave={async (data) => {
            const { project } = await postProject(data);
            onChange([...projects, project]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function ProjectList(props: {
  projects: ProjectDto[];
  onChange: (next: ProjectDto[]) => void;
  onReorder: (idsInOrder: string[]) => void;
  disabled: boolean;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  function reorder(fromId: string, toId: string) {
    if (fromId === toId) return;
    const ids = props.projects.map((p) => p.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = ids.slice();
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, fromId);
    props.onReorder(next);
  }

  return (
    <ul className="flex flex-col gap-3">
      {props.projects.map((project, idx) => (
        <li
          key={project.id}
          draggable={!props.disabled}
          onDragStart={(e: DragEvent<HTMLLIElement>) => {
            setDraggingId(project.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (draggingId) reorder(draggingId, project.id);
            setDraggingId(null);
          }}
          onDragEnd={() => setDraggingId(null)}
          className={cn(
            "transition-shadow",
            draggingId === project.id ? "opacity-60" : "",
          )}
        >
          <ProjectCard
            project={project}
            order={idx + 1}
            onUpdate={(next) =>
              props.onChange(
                props.projects.map((p) => (p.id === next.id ? next : p)),
              )
            }
            onDelete={() =>
              props.onChange(props.projects.filter((p) => p.id !== project.id))
            }
          />
        </li>
      ))}
    </ul>
  );
}

function ProjectCard(props: {
  project: ProjectDto;
  order: number;
  onUpdate: (next: ProjectDto) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function performDelete() {
    setDeleting(true);
    try {
      await deleteProject(props.project.id);
      props.onDelete();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <Collapsible open={open || editing} onOpenChange={setOpen}>
        <CardHeader className="flex flex-row items-start gap-2 p-4">
          <span
            className="mt-1 cursor-grab text-muted-foreground"
            aria-hidden
            title="Drag to reorder"
          >
            <GripVertical className="size-4" />
          </span>
          <CollapsibleTrigger className="flex flex-1 items-start gap-2 text-left">
            <ChevronDown
              className={cn(
                "mt-1 size-4 text-muted-foreground transition-transform",
                open || editing ? "" : "-rotate-90",
              )}
              aria-hidden
            />
            <div className="flex-1">
              <p className="text-sm font-semibold">
                {props.order}. {props.project.name || "Untitled project"}
              </p>
              {props.project.companyContext ? (
                <p className="text-xs text-muted-foreground">
                  {props.project.companyContext}
                </p>
              ) : null}
            </div>
          </CollapsibleTrigger>
          <div className="flex items-center gap-1">
            {!editing ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            ) : null}
            {confirmDelete ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={performDelete}
                  disabled={deleting}
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  {deleting ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  Confirm
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete project"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="p-4 pt-0">
            {editing ? (
              <ProjectForm
                mode="edit"
                initial={props.project}
                onSave={async (patch) => {
                  const { project } = await patchProject(props.project.id, patch);
                  props.onUpdate(project);
                  setEditing(false);
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <ReadView project={props.project} />
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ReadView({ project }: { project: ProjectDto }) {
  const fields: Array<[string, string | null]> = [
    ["Time period", project.timePeriod],
    ["Scale", project.scaleDescription],
    ["Team size", project.teamSize],
    ["My role", project.myRole],
    ["Key decisions", project.keyDecisions],
    ["Outcomes", project.outcomesWithMetrics],
  ];
  const present = fields.filter(([, v]) => v && v.trim().length > 0);
  if (present.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No details yet. Click Edit to flesh this one out.
      </p>
    );
  }
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {present.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs uppercase tracking-wider text-muted-foreground">
            {label}
          </dt>
          <dd className="whitespace-pre-line">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface ProjectFormProps {
  mode: "create" | "edit";
  initial?: ProjectDto;
  onSave: (data: ProjectFormData) => Promise<void>;
  onCancel: () => void;
}

interface ProjectFormData {
  name: string;
  companyContext: string | null;
  timePeriod: string | null;
  scaleDescription: string | null;
  teamSize: string | null;
  myRole: string | null;
  keyDecisions: string | null;
  outcomesWithMetrics: string | null;
}

function ProjectForm(props: ProjectFormProps) {
  const formId = useId();
  const [data, setData] = useState<ProjectFormData>(() => ({
    name: props.initial?.name ?? "",
    companyContext: props.initial?.companyContext ?? "",
    timePeriod: props.initial?.timePeriod ?? "",
    scaleDescription: props.initial?.scaleDescription ?? "",
    teamSize: props.initial?.teamSize ?? "",
    myRole: props.initial?.myRole ?? "",
    keyDecisions: props.initial?.keyDecisions ?? "",
    outcomesWithMetrics: props.initial?.outcomesWithMetrics ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!data.name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    try {
      // Empty-string → null cleanup happens at the Zod layer too,
      // but we send null explicitly so absent keys aren't sent.
      const payload: ProjectFormData = {
        name: data.name.trim(),
        companyContext: data.companyContext?.trim() || null,
        timePeriod: data.timePeriod?.trim() || null,
        scaleDescription: data.scaleDescription?.trim() || null,
        teamSize: data.teamSize?.trim() || null,
        myRole: data.myRole?.trim() || null,
        keyDecisions: data.keyDecisions?.trim() || null,
        outcomesWithMetrics: data.outcomesWithMetrics?.trim() || null,
      };
      await props.onSave(payload);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Could not save project.";
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      id={formId}
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <div>
        <Label htmlFor={`${formId}-name`}>Name</Label>
        <Input
          id={`${formId}-name`}
          value={data.name}
          onChange={(e) => setData({ ...data, name: e.target.value })}
          placeholder="Multi-region payments migration"
          className="mt-1"
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${formId}-company`}>Company / context</Label>
          <Input
            id={`${formId}-company`}
            value={data.companyContext ?? ""}
            onChange={(e) =>
              setData({ ...data, companyContext: e.target.value })
            }
            placeholder="Razorpay — Payments platform"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor={`${formId}-period`}>Time period</Label>
          <Input
            id={`${formId}-period`}
            value={data.timePeriod ?? ""}
            onChange={(e) => setData({ ...data, timePeriod: e.target.value })}
            placeholder="Q3 2023 — Q1 2024"
            className="mt-1"
          />
        </div>
      </div>

      <div>
        <Label htmlFor={`${formId}-scale`}>Scale</Label>
        <Textarea
          id={`${formId}-scale`}
          value={data.scaleDescription ?? ""}
          onChange={(e) =>
            setData({ ...data, scaleDescription: e.target.value })
          }
          placeholder="500k transactions/day, $1B annualized volume, 9 regions"
          rows={2}
          className="mt-1"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${formId}-team`}>Team size</Label>
          <Input
            id={`${formId}-team`}
            value={data.teamSize ?? ""}
            onChange={(e) => setData({ ...data, teamSize: e.target.value })}
            placeholder="6 engineers + 1 PM"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor={`${formId}-role`}>My role</Label>
          <Input
            id={`${formId}-role`}
            value={data.myRole ?? ""}
            onChange={(e) => setData({ ...data, myRole: e.target.value })}
            placeholder="Tech lead"
            className="mt-1"
          />
        </div>
      </div>

      <div>
        <Label htmlFor={`${formId}-decisions`}>Key decisions</Label>
        <Textarea
          id={`${formId}-decisions`}
          value={data.keyDecisions ?? ""}
          onChange={(e) => setData({ ...data, keyDecisions: e.target.value })}
          rows={3}
          placeholder="Picked dual-write over CDC because we needed read-after-write semantics."
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor={`${formId}-outcomes`}>Outcomes with metrics</Label>
        <Textarea
          id={`${formId}-outcomes`}
          value={data.outcomesWithMetrics ?? ""}
          onChange={(e) =>
            setData({ ...data, outcomesWithMetrics: e.target.value })
          }
          rows={3}
          placeholder="P99 dropped from 380ms → 110ms; reduced regional outages from 2/quarter → 0."
          className="mt-1"
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          {props.mode === "create" ? "Add project" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
