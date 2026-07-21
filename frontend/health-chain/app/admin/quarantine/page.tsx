"use client";

import React, { useMemo, useState } from 'react';
import {
  useAssignQuarantineReviewer,
  useFinalizeQuarantineCase,
  useQuarantineCases,
  useUpdateQuarantineReview,
} from '@/lib/hooks/useQuarantine';
import type {
  QueryQuarantineCasesParams,
  QuarantineCase,
  QuarantineDisposition,
  QuarantineReviewState,
} from '@/lib/types/quarantine';
import {
  Badge,
  Button,
  EmptyState,
  ErrorDisplay,
  Input,
  LoadingSpinner,
  Modal,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textarea,
} from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';

const REVIEW_STATES: QuarantineReviewState[] = [
  'PENDING', 'UNDER_REVIEW', 'APPROVED_RELEASE', 'APPROVED_DISCARD', 'CLOSED',
];

const STATE_BADGE: Record<QuarantineReviewState, BadgeVariant> = {
  PENDING: 'pending',
  UNDER_REVIEW: 'info',
  APPROVED_RELEASE: 'active',
  APPROVED_DISCARD: 'critical',
  CLOSED: 'default',
};

function ReviewPanel({ selected, onClose }: { selected: QuarantineCase; onClose: () => void }) {
  const assignMutation = useAssignQuarantineReviewer();
  const reviewMutation = useUpdateQuarantineReview();
  const finalizeMutation = useFinalizeQuarantineCase();

  const [assignee, setAssignee] = useState(selected.reviewerAssignedTo || '');
  const [reviewState, setReviewState] = useState<QuarantineReviewState>(selected.reviewState);
  const [reviewNotes, setReviewNotes] = useState(selected.notes || '');
  const [disposition, setDisposition] = useState<QuarantineDisposition>('RELEASE');
  const [dispositionNotes, setDispositionNotes] = useState('');
  const [policyReference, setPolicyReference] = useState(selected.policyReference || '');

  return (
    <Modal open onClose={onClose} title="Quarantine Review" className="max-w-2xl">
      <p className="text-sm text-text-muted mb-4">Case {selected.id.slice(0, 8)}...</p>

      <div className="grid gap-3 rounded-lg border border-border-muted bg-surface-raised p-4 text-sm text-text-secondary md:grid-cols-2 mb-4">
        <p><span className="font-semibold">Blood Unit:</span> {selected.bloodUnitId}</p>
        <p><span className="font-semibold">Trigger:</span> {selected.triggerSource}</p>
        <p><span className="font-semibold">Reason Code:</span> {selected.reasonCode}</p>
        <p><span className="font-semibold">Current State:</span> {selected.reviewState}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_auto] mb-4">
        <Input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assign reviewer (user id)"
        />
        <Button
          onClick={() => assignMutation.mutate({ caseId: selected.id, reviewerAssignedTo: assignee })}
          disabled={!assignee}
          loading={assignMutation.isPending}
        >
          Assign
        </Button>
      </div>

      <div className="space-y-2 mb-4">
        <Select
          label="Review State"
          value={reviewState}
          onChange={(e) => setReviewState(e.target.value as QuarantineReviewState)}
          options={REVIEW_STATES.map((s) => ({ value: s, label: s }))}
        />
        <Textarea
          value={reviewNotes}
          onChange={(e) => setReviewNotes(e.target.value)}
          rows={3}
          placeholder="Review notes"
        />
        <Button
          variant="secondary"
          loading={reviewMutation.isPending}
          onClick={() => reviewMutation.mutate({ caseId: selected.id, payload: { reviewState, notes: reviewNotes } })}
        >
          Save Review
        </Button>
      </div>

      <div className="space-y-2 border-t border-border-muted pt-4">
        <h3 className="text-sm font-bold text-text-primary">Final Disposition</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as QuarantineDisposition)}
            options={[{ value: 'RELEASE', label: 'Release' }, { value: 'DISCARD', label: 'Discard' }]}
          />
          <Input
            value={policyReference}
            onChange={(e) => setPolicyReference(e.target.value)}
            placeholder="Policy reference"
          />
        </div>
        <Textarea
          value={dispositionNotes}
          onChange={(e) => setDispositionNotes(e.target.value)}
          rows={3}
          placeholder="Disposition rationale"
        />
        <Button
          variant="destructive"
          loading={finalizeMutation.isPending}
          onClick={() => finalizeMutation.mutate(
            { caseId: selected.id, payload: { disposition, notes: dispositionNotes, policyReference } },
            { onSuccess: onClose }
          )}
        >
          Finalize
        </Button>
      </div>
    </Modal>
  );
}

export default function QuarantineReviewPage() {
  const [selected, setSelected] = useState<QuarantineCase | null>(null);
  const [filters, setFilters] = useState<QueryQuarantineCasesParams>({ active: true });
  const { data, isLoading, isError, refetch } = useQuarantineCases(filters);
  const rows = useMemo(() => data?.data ?? [], [data]);

  return (
    <div className="min-h-screen space-y-6 bg-surface p-6 lg:p-10">
      {selected && <ReviewPanel selected={selected} onClose={() => setSelected(null)} />}

      <div className="border-b border-border-muted pb-5">
        <h1 className="text-3xl font-bold text-text-primary">Quarantine Review Console</h1>
        <p className="text-sm text-text-muted">
          Lab and compliance teams can investigate triggers, assign reviewers, and finalize release or discard decisions.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {[true, false].map((active) => (
          <button
            key={String(active)}
            onClick={() => setFilters((prev) => ({ ...prev, active }))}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
              filters.active === active
                ? 'border-[#D32F2F] bg-[#D32F2F] text-white'
                : 'border-border-muted bg-surface text-text-muted hover:border-[#D32F2F]'
            }`}
          >
            {active ? 'Active Cases' : 'Closed Cases'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorDisplay message="Failed to load quarantine cases." onRetry={refetch} />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <TableHeaderCell>Case</TableHeaderCell>
              <TableHeaderCell>Blood Unit</TableHeaderCell>
              <TableHeaderCell>Trigger</TableHeaderCell>
              <TableHeaderCell>Reason</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Reviewer</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell />
            </tr>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <tr><td colSpan={8}><EmptyState title="No quarantine cases found." /></td></tr>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold">{row.id.slice(0, 8)}...</TableCell>
                <TableCell>{row.bloodUnitId.slice(0, 8)}...</TableCell>
                <TableCell>{row.triggerSource}</TableCell>
                <TableCell>{row.reasonCode}</TableCell>
                <TableCell><Badge variant={STATE_BADGE[row.reviewState]}>{row.reviewState}</Badge></TableCell>
                <TableCell className="text-text-muted">{row.reviewerAssignedTo || '-'}</TableCell>
                <TableCell className="text-text-muted">{new Date(row.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="secondary" onClick={() => setSelected(row)}>Review</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}


const REVIEW_STATES: QuarantineReviewState[] = [
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED_RELEASE',
  'APPROVED_DISCARD',
  'CLOSED',
];

function StatusPill({ state }: { state: QuarantineReviewState }) {
  const style =
    state === 'PENDING'
      ? 'bg-yellow-50 text-yellow-700'
      : state === 'UNDER_REVIEW'
        ? 'bg-blue-50 text-blue-700'
        : state === 'APPROVED_RELEASE'
          ? 'bg-green-50 text-green-700'
          : state === 'APPROVED_DISCARD'
            ? 'bg-red-50 text-red-700'
            : 'bg-gray-100 text-gray-600';

  return (
    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${style}`}>
      {state}
    </span>
  );
}

function ReviewPanel({
  selected,
  onClose,
}: {
  selected: QuarantineCase;
  onClose: () => void;
}) {
  const assignMutation = useAssignQuarantineReviewer();
  const reviewMutation = useUpdateQuarantineReview();
  const finalizeMutation = useFinalizeQuarantineCase();

  const [assignee, setAssignee] = useState(selected.reviewerAssignedTo || '');
  const [reviewState, setReviewState] = useState<QuarantineReviewState>(
    selected.reviewState,
  );
  const [reviewNotes, setReviewNotes] = useState(selected.notes || '');
  const [disposition, setDisposition] = useState<QuarantineDisposition>('RELEASE');
  const [dispositionNotes, setDispositionNotes] = useState('');
  const [policyReference, setPolicyReference] = useState(
    selected.policyReference || '',
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-2xl space-y-5 rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-brand-black">Quarantine Review</h2>
            <p className="text-sm text-gray-500">Case {selected.id.slice(0, 8)}...</p>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-600"
          >
            Close
          </button>
        </div>

        <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 md:grid-cols-2">
          <p>
            <span className="font-semibold">Blood Unit:</span> {selected.bloodUnitId}
          </p>
          <p>
            <span className="font-semibold">Trigger:</span> {selected.triggerSource}
          </p>
          <p>
            <span className="font-semibold">Reason Code:</span> {selected.reasonCode}
          </p>
          <p>
            <span className="font-semibold">Current State:</span> {selected.reviewState}
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="Assign reviewer (user id)"
          />
          <button
            onClick={() => assignMutation.mutate({ caseId: selected.id, reviewerAssignedTo: assignee })}
            disabled={!assignee || assignMutation.isPending}
            className="rounded bg-brand-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Assign
          </button>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-semibold text-gray-700">Review State</label>
          <select
            value={reviewState}
            onChange={(e) => setReviewState(e.target.value as QuarantineReviewState)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          >
            {REVIEW_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
          <textarea
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="Review notes"
          />
          <button
            onClick={() =>
              reviewMutation.mutate({
                caseId: selected.id,
                payload: { reviewState, notes: reviewNotes },
              })
            }
            disabled={reviewMutation.isPending}
            className="rounded border border-brand-black px-4 py-2 text-sm font-semibold text-brand-black"
          >
            Save Review
          </button>
        </div>

        <div className="space-y-2 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-bold text-brand-black">Final Disposition</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <select
              value={disposition}
              onChange={(e) => setDisposition(e.target.value as QuarantineDisposition)}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="RELEASE">Release</option>
              <option value="DISCARD">Discard</option>
            </select>
            <input
              value={policyReference}
              onChange={(e) => setPolicyReference(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
              placeholder="Policy reference"
            />
          </div>
          <textarea
            value={dispositionNotes}
            onChange={(e) => setDispositionNotes(e.target.value)}
            rows={3}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="Disposition rationale"
          />
          <button
            onClick={() =>
              finalizeMutation.mutate(
                {
                  caseId: selected.id,
                  payload: {
                    disposition,
                    notes: dispositionNotes,
                    policyReference,
                  },
                },
                { onSuccess: onClose },
              )
            }
            disabled={finalizeMutation.isPending}
            className="rounded bg-[#D32F2F] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Finalize
          </button>
        </div>
      </div>
    </div>
  );
}

export default function QuarantineReviewPage() {
  const [selected, setSelected] = useState<QuarantineCase | null>(null);
  const [filters, setFilters] = useState<QueryQuarantineCasesParams>({
    active: true,
  });

  const { data, isLoading, isError } = useQuarantineCases(filters);
  const rows = useMemo(() => data?.data ?? [], [data]);

  return (
    <div className="min-h-screen space-y-6 bg-white p-6 lg:p-10">
      {selected && <ReviewPanel selected={selected} onClose={() => setSelected(null)} />}

      <div className="border-b border-gray-100 pb-5">
        <h1 className="text-3xl font-bold text-brand-black">Quarantine Review Console</h1>
        <p className="text-sm text-gray-500">
          Lab and compliance teams can investigate triggers, assign reviewers, and finalize release or discard decisions.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {[true, false].map((active) => (
          <button
            key={String(active)}
            onClick={() => setFilters((prev) => ({ ...prev, active }))}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${
              filters.active === active
                ? 'border-brand-black bg-brand-black text-white'
                : 'border-gray-300 bg-white text-gray-600'
            }`}
          >
            {active ? 'Active Cases' : 'Closed Cases'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading quarantine cases...</p>
      ) : isError ? (
        <p className="text-sm text-red-600">Failed to load quarantine cases.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">Case</th>
                <th className="px-4 py-3 text-left">Blood Unit</th>
                <th className="px-4 py-3 text-left">Trigger</th>
                <th className="px-4 py-3 text-left">Reason</th>
                <th className="px-4 py-3 text-left">State</th>
                <th className="px-4 py-3 text-left">Reviewer</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                    No quarantine cases found.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">{row.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 text-gray-700">{row.bloodUnitId.slice(0, 8)}...</td>
                  <td className="px-4 py-3 text-gray-700">{row.triggerSource}</td>
                  <td className="px-4 py-3 text-gray-700">{row.reasonCode}</td>
                  <td className="px-4 py-3">
                    <StatusPill state={row.reviewState} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{row.reviewerAssignedTo || '-'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelected(row)}
                      className="rounded border-2 border-brand-black px-3 py-1 text-xs font-semibold text-brand-black"
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
