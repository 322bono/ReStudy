"use client";
import { forwardRef, useEffect, useId, useRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { X, LoaderCircle, FileText, ArrowUpRight } from "lucide-react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const buttonVariants = cva("button", {
  variants: {
    variant: {
      primary: "primary",
      secondary: "secondary",
      ghost: "ghost",
      danger: "danger",
    },
    size: { default: "", sm: "button-sm", icon: "button-icon" },
  },
  defaultVariants: { variant: "primary", size: "default" },
});
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { busy?: boolean; asChild?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      variant,
      size,
      busy = false,
      asChild = false,
      className,
      ...props
    },
    ref,
  ) {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
        disabled={props.disabled || busy}
        aria-busy={busy || undefined}
      >
        {asChild ? (
          children
        ) : (
          <>
            {busy && <LoaderCircle size={16} className="spin" />}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="닫기" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        {icon || <FileText size={25} strokeWidth={1.5} />}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "indigo" | "green" | "amber";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Sources({
  sources,
  materials,
  onOpen,
}: {
  sources: { materialId: string; page: number }[];
  materials: { id: string; title: string }[];
  onOpen: (id: string, page: number) => void;
}) {
  const links = (
    <div className="sources">
      {sources.map((s, i) => (
        <button key={i} onClick={() => onOpen(s.materialId, s.page)}>
          <FileText size={12} />
          {materials.find((m) => m.id === s.materialId)?.title ||
            "원본 자료"} · {s.page}쪽<ArrowUpRight size={12} />
        </button>
      ))}
    </div>
  );
  return sources.length>2 ? <details className="source-details"><summary>출처 보기 · {sources.length}쪽</summary>{links}</details> : links;
}
