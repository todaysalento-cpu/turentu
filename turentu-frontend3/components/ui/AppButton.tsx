import React from "react";
import { IconType } from "react-icons";

interface AppInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  icon?: IconType;
  containerClassName?: string;
}

export default function AppInput({
  label,
  icon: Icon,
  containerClassName = "",
  className = "",
  ...props
}: AppInputProps) {
  return (
    <div className={`flex flex-col gap-1 ${containerClassName}`}>
      {label && (
        <label className="text-sm font-medium text-gray-700">
          {label}
        </label>
      )}

      <div className="relative">
        {Icon && (
          <Icon className="absolute left-3 top-1/2 -translate-y-1/2 text-[#ff3036]" />
        )}

        <input
          {...props}
          className={`
            w-full h-[48px]
            ${Icon ? "pl-10" : "pl-4"}
            pr-4
            rounded-xl
            border border-gray-300
            bg-white
            text-sm
            focus:outline-none
            focus:border-[#ff3036]
            focus:ring-2 focus:ring-[#ff3036]/20
            transition
            ${className}
          `}
        />
      </div>
    </div>
  );
}
