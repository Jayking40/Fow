"use client";

import React, { useState } from "react";
import { useAnomalies, useReviewAnomaly } from "@/lib/hooks/useAnomalies";
import type {
  AnomalyIncident,
  AnomalyQueryParams,
  AnomalyStatus,
  AnomalySeverity,
  AnomalyType,
} from "@/lib/types/anomaly";
import {
  Badge,
  Button,
  EmptyState,
  LoadingSpinner,
  ErrorDisplay,
  Modal,
  Pagination,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textarea,
} from "@/components/ui";
import type { BadgeVariant } from "@/components/ui";

const SEVERITY_BADGE: Record<AnomalySeverity, BadgeVariant> = {
  HIGH: "critical",
  MEDIUM: "pending",
  LOW: "default",
};

const STATUS_BADGE: Record<AnomalyStatus, BadgeVariant> = {
  OPEN: "critical",
  INVESTIGATING: "info",
  DISMISSED: "default",
  RESOLVED: "resolved",
};

const TYPE_LABELS: Record<AnomalyType, string> = {
  DUPLICATE_EMERGENCY_REQUEST: "Duplicate Emergency Request",
  RIDER_ROUTE_DEVIATION: "Rider Cancellation Anomaly",
  REPEATED_ESCROW_DISPUTE: "Repeated Escrow Dispute",
  SUDDEN_STOCK_SWING: "Sudden Stock Swing",
};

function ReviewModal({
  incident,
  onClose,
}: {
  incident: AnomalyIncident;
  onClose: () => void;
}) {
  const { mutate, isPending } = useReviewAnomaly();
  const [status, setStatus] = useState<AnomalyStatus>(incident.status);
  const [notes, setNotes] = useState(incident.reviewNotes ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    mutate({ id: incident.id, payload: { status, reviewNotes: notes } }, { onSuccess: onClose });
  }

  return (
    <Modal open onClose={onClose} title="Review Anomaly">
      <div className="text-sm text-text-secondary space-y-1 mb-4">
        <p><span className="font-semibold">Type:</span> {TYPE_LABELS[incident.type]}</p>
        <p><span className="font-semibold">Description:</span> {incident.description}</p>
        {incident.hospitalId && <p><span className="font-semibold">Hospital:</span> {incident.hospitalId}</p>}
        {incident.riderId && <p><span className="font-semibold">Rider:</span> {incident.riderId}</p>}
        {incident.orderId && <p><span className="font-semibold">Order:</span> {incident.orderId}</p>}
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Update Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AnomalyStatus)}
          options={[
            { value: "OPEN", label: "Open" },
            { value: "INVESTIGATING", label: "Investigating" },
            { value: "DISMISSED", label: "Dismissed" },
            { value: "RESOLVED", label: "Resolved" },
          ]}
        />
        <Textarea
          label="Review Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Add investigation notes..."
        />
        <div className="flex gap-3 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={isPending}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function AnomalyQueuePage() {
  const [filters, setFilters] = useState<AnomalyQueryParams>({
    status: "OPEN",
    page: 1,
    pageSize: 25,
  });
  const [selected, setSelected] = useState<AnomalyIncident | null>(null);
  const { data, isLoading, isError, refetch } = useAnomalies(filters);

  function setFilter<K extends keyof AnomalyQueryParams>(key: K, value: AnomalyQueryParams[K]) {
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  }

  return (
    <div className="p-6 lg:p-10 space-y-8 bg-surface min-h-screen font-roboto">
      {selected && <ReviewModal incident={selected} onClose={() => setSelected(null)} />}

      <div className="border-b border-border-muted pb-6">
        <h1 className="text-[32px] font-manrope font-bold text-text-primary">Anomaly Queue</h1>
        <p className="text-text-muted mt-1">Review and investigate suspicious operational patterns.</p>
      </div>

      <div className="flex flex-wrap gap-3">
        {(["OPEN", "INVESTIGATING", "DISMISSED", "RESOLVED", undefined] as const).map((s) => (
          <button
            key={s ?? "ALL"}
            onClick={() => setFilter("status", s)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold border-2 transition-all ${
              filters.status === s
                ? "bg-[#D32F2F] text-white border-[#D32F2F]"
                : "bg-surface text-text-muted border-border-muted hover:border-[#D32F2F]"
            }`}
          >
            {s ?? "All"}
          </button>
        ))}
        <Select
          className="ml-auto w-auto"
          value={filters.severity ?? ""}
          onChange={(e) => setFilter("severity", (e.target.value as AnomalySeverity) || undefined)}
          options={[
            { value: "", label: "All Severities" },
            { value: "HIGH", label: "High" },
            { value: "MEDIUM", label: "Medium" },
            { value: "LOW", label: "Low" },
          ]}
        />
        <Select
          className="w-auto"
          value={filters.type ?? ""}
          onChange={(e) => setFilter("type", (e.target.value as AnomalyType) || undefined)}
          options={[
            { value: "", label: "All Types" },
            ...Object.entries(TYPE_LABELS).map(([k, v]) => ({ value: k, label: v })),
          ]}
        />
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorDisplay message="Failed to load anomalies." onRetry={refetch} />
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell>
                <TableHeaderCell>Severity</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Detected</TableHeaderCell>
                <TableHeaderCell>Links</TableHeaderCell>
                <TableHeaderCell />
              </tr>
            </TableHead>
            <TableBody>
              {data?.data.length === 0 && (
                <tr><td colSpan={7}><EmptyState title="No anomalies found." /></td></tr>
              )}
              {data?.data.map((incident) => (
                <TableRow key={incident.id}>
                  <TableCell className="font-medium whitespace-nowrap">{TYPE_LABELS[incident.type]}</TableCell>
                  <TableCell className="max-w-xs truncate text-text-muted">{incident.description}</TableCell>
                  <TableCell><Badge variant={SEVERITY_BADGE[incident.severity]}>{incident.severity}</Badge></TableCell>
                  <TableCell><Badge variant={STATUS_BADGE[incident.status]}>{incident.status}</Badge></TableCell>
                  <TableCell className="text-text-muted whitespace-nowrap">{new Date(incident.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-xs text-text-muted space-x-2">
                    {incident.hospitalId && <span title="Hospital">🏥 {incident.hospitalId.slice(0, 8)}</span>}
                    {incident.riderId && <span title="Rider">🛵 {incident.riderId.slice(0, 8)}</span>}
                    {incident.orderId && <span title="Order">📦 {incident.orderId.slice(0, 8)}</span>}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="secondary" onClick={() => setSelected(incident)}>Review</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {data && data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-text-muted">
              <span>{data.pagination.totalCount} anomalies · Page {data.pagination.currentPage} of {data.pagination.totalPages}</span>
              <Pagination
                page={filters.page ?? 1}
                totalPages={data.pagination.totalPages}
                onPageChange={(p) => setFilters((prev) => ({ ...prev, page: p }))}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
