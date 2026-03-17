'use client';

import { useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { Calendar } from "react-calendar";
import 'react-calendar/dist/Calendar.css';

interface BottomSheetCalendarioProps {
  value: string;
  onClose: () => void;
  onConfirm: (iso: string) => void;
}

export default function BottomSheetCalendario({ value, onClose, onConfirm }: BottomSheetCalendarioProps) {
  const [selected, setSelected] = useState(value);

  return (
    <BottomSheet open onClose={onClose}>
      <div className="p-4 flex flex-col gap-4">
        <h3 className="text-lg font-bold">Seleziona Data e Ora</h3>

        {/* Solo calendario */}
        <Calendar
          value={new Date(selected)}
          onChange={(date: Date) => setSelected(date.toISOString().slice(0, 16))}
        />

        <button
          type="button"
          onClick={() => onConfirm(selected)}
          className="w-full bg-[#ff3036] text-white py-4 rounded-xl font-semibold text-lg"
        >
          Conferma
        </button>
      </div>
    </BottomSheet>
  );
}
