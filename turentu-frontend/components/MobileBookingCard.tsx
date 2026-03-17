'use client';

import { useState } from "react";
import { FaMapMarkerAlt, FaCalendarAlt } from "react-icons/fa";
import AppInput, { inputBaseClasses } from "./ui/appInput";
import PostiSelector from "./PostiSelector";
import BookingCard from "./BookingCard";
import { RicercaForm } from "./SearchFormTypes";

interface MobileBookingCardProps {
  form: RicercaForm;
  dispatch: React.Dispatch<any>;
  onSubmit: () => void;
}

export default function MobileBookingCard({ form, dispatch, onSubmit }: MobileBookingCardProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);

  return (
    <BookingCard className="p-4 h-[90vh]">
      {/* Contenuto centrale */}
      <div className="flex flex-col gap-4">
        <AppInput
          value={form.localitaOrigine ?? ""}
          placeholder="Da dove parti?"
          icon={<FaMapMarkerAlt className="text-[#ff3036]" />}
          onChange={(e) => dispatch({ type: "SET_ORIGINE", payload: e.target.value })}
        />

        <AppInput
          value={form.localitaDestinazione ?? ""}
          placeholder="Dove vai?"
          icon={<FaMapMarkerAlt className="text-[#ff3036]" />}
          onChange={(e) => dispatch({ type: "SET_DESTINAZIONE", payload: e.target.value })}
        />

        <AppInput
          readOnly
          value={form.start_datetime ?? ""}
          placeholder="Seleziona data e ora"
          icon={<FaCalendarAlt className="text-[#ff3036]" />}
          onClick={() => setCalendarOpen(true)}
        />

        <PostiSelector
          value={form.posti_richiesti ?? 1}
          onChange={(v) => dispatch({ type: "SET_POSTI", payload: v })}
        />
      </div>

      {/* Footer */}
      <div className="mt-6">
        <button
          type="button"
          onClick={onSubmit}
          className="w-full h-[56px] bg-[#ff3036] text-white rounded-xl font-semibold text-lg"
        >
          Cerca
        </button>
      </div>
    </BookingCard>
  );
}
