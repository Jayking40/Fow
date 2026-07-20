# UI Component Kit — `components/ui`

Shared design-system primitives for the Health Chain frontend. Built with Tailwind CSS, `clsx`, and `tailwind-merge`. All components are dark-mode ready via semantic CSS tokens.

## Usage

```tsx
import { Button, Badge, Card, Modal } from "@/components/ui";
```

## Components

| Component | Description |
|-----------|-------------|
| `Button` | `primary / secondary / destructive / ghost` variants, `sm / md / lg` sizes, `loading` state |
| `Input` | Labelled text input with error state |
| `Textarea` | Labelled textarea with error state |
| `Select` | Labelled select with options array |
| `Checkbox` | Accessible checkbox with label |
| `RadioGroup` | Accessible radio group |
| `Switch` | Toggle switch with `aria-checked` |
| `Badge` | Status variants: `pending / active / critical / resolved / info / default` |
| `Card` | Surface card with `CardHeader`, `CardTitle`, `CardContent` sub-components |
| `Modal` | Focus-trapped dialog with ESC and overlay close |
| `Tooltip` | Hover/focus tooltip |
| `Tabs` | Keyboard-navigable tab panel (arrow keys) |
| `Skeleton` | Animated loading placeholder |
| `EmptyState` | Empty list/page state with optional icon and action |
| `Pagination` | Page navigation with prev/next and numbered pages |
| `Table` | `Table`, `TableHead`, `TableBody`, `TableRow`, `TableCell`, `TableHeaderCell` |
| `Toast` | Slide-in notification (success / error / warning / info) |
| `LoadingSpinner` | Animated spinner, full-page or inline |
| `ErrorDisplay` | Error card with optional retry button |

## Semantic tokens

Components use CSS variable tokens defined in `globals.css` and mapped in `tailwind.config.ts`:

| Token | Light | Dark |
|-------|-------|------|
| `bg-surface` | `#ffffff` | `#1a1a2e` |
| `bg-surface-raised` | `#f5f7fa` | `#16213e` |
| `text-primary` | `#1a1a1a` | `#f1f5f9` |
| `text-secondary` | `#3c3c3c` | `#cbd5e1` |
| `text-muted` | `#6b7280` | `#94a3b8` |
| `border-muted` | `#e5e7eb` | `#334155` |

## Rules

- Every component uses `forwardRef` where applicable
- All interactive components are keyboard accessible
- Dark mode is handled via the `dark:` Tailwind prefix using semantic tokens
- Use `cn()` from `@/lib/utils/cn` to compose class names
