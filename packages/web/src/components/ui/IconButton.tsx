import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "./Button";

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  children: ReactNode;
};

/** Renders an icon-only button with an accessible label. */
export function IconButton({ label, title, children, ...props }: IconButtonProps) {
  return (
    <Button aria-label={label} size="icon" title={title ?? label} {...props}>
      {children}
    </Button>
  );
}
