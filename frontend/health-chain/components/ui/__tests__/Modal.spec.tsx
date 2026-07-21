import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Test">
        <p>Content</p>
      </Modal>
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title and children when open", () => {
    render(
      <Modal open onClose={() => {}} title="My Modal">
        <p>Modal body</p>
      </Modal>
    );
    expect(screen.getByText("My Modal")).toBeTruthy();
    expect(screen.getByText("Modal body")).toBeTruthy();
  });

  it("calls onClose when ESC is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="ESC Test">
        <button>focusable</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Overlay Test">
        <p>body</p>
      </Modal>
    );
    // The overlay is the aria-hidden div behind the panel
    const overlay = document.querySelector("[aria-hidden='true']") as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("has role=dialog and aria-modal", () => {
    render(
      <Modal open onClose={() => {}} title="A11y">
        <p>body</p>
      </Modal>
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  });
});
