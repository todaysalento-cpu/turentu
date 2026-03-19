'use client';
import React from "react";

interface AppInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  size?: "sm" | "md" | "lg"; // nuova prop per altezza
}

export default function AppInput({
  icon,
  value,
  className,
  size = "md",
  ...props
}: AppInputProps) {
  // Definisce altezza e padding in base alla dimensione
  const sizeClasses =
    size === "sm"
      ? "h-10 py-2 text-sm"
      : size === "lg"
      ? "h-16 py-4 text-lg"
      : "h-12 py-3 text-base"; // md di default

  return (
    <div className="relative w-full">
      {icon && (
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
          {icon}
        </span>
      )}
      <input
        {...props}
        value={value ?? ""}
        className={`w-full rounded-xl border border-gray-300 px-4 focus:outline-none focus:ring-2 focus:ring-[#ff3036] 
                   ${icon ? "pl-12" : ""} ${sizeClasses} ${className || ""}`}
      />
    </div>
  );
}
