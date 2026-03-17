'use client';
import React from "react";

interface AppInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}

export default function AppInput({
  icon,
  value,
  className = "",
  size = "md",
  ...props
}: AppInputProps) {
  // Altezza e padding in base alla dimensione
  const sizeMap: Record<string, string> = {
    sm: "h-10 py-2 text-sm",
    md: "h-12 py-3 text-base",
    lg: "h-16 py-4 text-lg",
  };

  // Stili comuni DRY per tutti gli input
  const baseClasses = `
    w-full rounded-xl border 
    border-gray-300 dark:border-gray-600
    bg-white dark:bg-gray-800 text-slate-900 dark:text-slate-100
    focus:outline-none focus:ring-2 focus:ring-[#ff3036]
    placeholder:text-gray-400 dark:placeholder:text-gray-500
    transition-colors duration-200
  `;

  // Padding se presente icona
  const paddingClasses = icon ? "pl-12 pr-4" : "px-4";

  return (
    <div className="relative w-full">
      {icon && (
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
          {icon}
        </span>
      )}
      <input
        {...props}
        value={value ?? ""}
        className={`${baseClasses} ${paddingClasses} ${sizeMap[size]} ${className}`}
      />
    </div>
  );
}