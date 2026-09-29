import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** shadcn/ui foundation: the generated Button and the `cn` class helper (DEC-035). */
describe("cn", () => {
  it("joins conditional classes and lets later Tailwind classes win", () => {
    const disabled = false;
    expect(cn("px-2 py-1", disabled && "opacity-50", "px-4")).toBe("py-1 px-4");
  });
});

describe("Button", () => {
  it("renders a native button with the default variant", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("default");
    expect(button.className).toContain("bg-primary");
  });

  it("merges caller classes over variant classes", () => {
    render(
      <Button variant="outline" size="sm" className="px-6">
        Cancel
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button.dataset.variant).toBe("outline");
    expect(button.className).toContain("px-6");
    expect(button.className).not.toContain("px-2.5");
  });

  it("renders its child element when asChild is set", () => {
    render(
      <Button asChild>
        <a href="/help">Help</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Help" });
    expect(link.getAttribute("href")).toBe("/help");
    expect(link.dataset.slot).toBe("button");
  });
});
