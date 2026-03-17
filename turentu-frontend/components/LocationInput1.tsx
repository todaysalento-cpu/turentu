'use client';

import { FaMapMarkerAlt } from "react-icons/fa";
import AppInput from "./ui/appInput";

interface LocationInputProps {
  label: string;
  value: string;
  onChange?: (val: string) => void;
  onClick?: () => void;
  readOnly?: boolean;
  isDestinazione?: boolean;
}

export default function LocationInput({
  label,
  value,
  onChange,
  onClick,
  readOnly = false,
  isDestinazione = false,
}: LocationInputProps) {
  return (
    <AppInput
      value={value ?? ""}
      placeholder={label}
      readOnly={readOnly}
      onClick={onClick}
      onChange={(e) => onChange?.(e.target.value)}
      icon={
        <FaMapMarkerAlt
          className={`${
            isDestinazione ? "text-[#ff3036]" : "text-[#ff3036]"
          }`}
        />
      }
    />
  );
}
