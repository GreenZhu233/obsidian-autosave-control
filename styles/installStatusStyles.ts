export function installStatusStyles(): HTMLStyleElement {
  const styleElement = document.createElement("style");
  styleElement.setAttribute("data-asc", "styles");
  styleElement.textContent = `
    .save-status-icon.asc-saved { color: var(--asc-saved-color, #32cd32); }
    .save-status-icon.asc-pending { color: var(--asc-pending-color, #00bfff); }
  `;

  document.head.appendChild(styleElement);
  return styleElement;
}
