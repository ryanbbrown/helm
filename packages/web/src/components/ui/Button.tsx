import { forwardRef, type ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
};

/** Renders a styled dashboard button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", className = "", ...props }, ref) {
  return <button className={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()} ref={ref} {...props} />;
});
