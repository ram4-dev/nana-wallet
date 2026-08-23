import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgenteAvatar, type AgenteEstado } from "./AgenteAvatar";

describe("AgenteAvatar", () => {
  const estados: AgenteEstado[] = [
    "listo",
    "escuchando",
    "pensando",
    "esperando_confirmacion",
    "no_entendi",
  ];

  it("muestra una reacción de Nani y una descripción accesible en cada estado", () => {
    for (const estado of estados) {
      const { container, unmount } = render(<AgenteAvatar estado={estado} />);
      const avatar = container.querySelector("[data-avatar-state]");
      const image = container.querySelector("img");

      expect(avatar, estado).toHaveAttribute("data-avatar-state", estado);
      expect(avatar, estado).toHaveAttribute("role", "img");
      expect(avatar, estado).toHaveAccessibleName();
      expect(image, estado).toHaveAttribute("alt", "");
      unmount();
    }
  });

  it("usa las reacciones correspondientes al momento", () => {
    const { container, rerender } = render(<AgenteAvatar estado="listo" />);
    const image = () => container.querySelector("img");

    expect(image()).toHaveClass("nani-avatar-image--lista");
    rerender(<AgenteAvatar estado="escuchando" />);
    expect(image()).toHaveClass("nani-avatar-image--escuchando");
    rerender(<AgenteAvatar estado="pensando" />);
    expect(image()).toHaveClass("nani-avatar-image--pensando");
    rerender(<AgenteAvatar estado="no_entendi" />);
    expect(image()).toHaveClass("nani-avatar-image--pensando");
  });
});
