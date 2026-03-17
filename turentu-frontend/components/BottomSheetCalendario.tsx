'use client';
import { useState, useEffect } from "react";

interface BottomSheetCalendarioProps {
  value: string; // ISO string
  onConfirm: (iso: string) => void;
}

export default function BottomSheetCalendario({ value, onConfirm }: BottomSheetCalendarioProps) {
  const [step, setStep] = useState<"day" | "hour">("day");
  const [tab, setTab] = useState<"oggi" | "domani" | "altro">("oggi");
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());
  const [selectedHour, setSelectedHour] = useState<number>(new Date().getHours());
  const [days, setDays] = useState<Date[]>([]);
  const [currentMonthIndex, setCurrentMonthIndex] = useState(new Date().getMonth());

  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const monthLabels = Array.from({ length: 12 }, (_, i) =>
    new Date(0, i).toLocaleDateString("it-IT", { month: "short" }).toUpperCase()
  );

  useEffect(() => {
    const today = new Date();
    const tempDays: Date[] = Array.from({ length: 365 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      return d;
    });
    setDays(tempDays);
  }, []);

  const selectTab = (t: "oggi" | "domani" | "altro") => {
    setTab(t);
    const today = new Date();
    if (t === "oggi") {
      setSelectedDay(today);
      setStep("hour");
    } else if (t === "domani") {
      const d = new Date(today);
      d.setDate(today.getDate() + 1);
      setSelectedDay(d);
      setStep("hour");
    } else {
      setStep("day");
    }
  };

  const handleConfirm = () => {
    const finalDate = new Date(selectedDay);
    finalDate.setHours(selectedHour, 0, 0, 0);

    // Mantieni l'ora locale corretta per TIMESTAMP WITH TIME ZONE
    const offsetMs = finalDate.getTimezoneOffset() * 60 * 1000;
    const localIso = new Date(finalDate.getTime() - offsetMs).toISOString().slice(0, 16);

    onConfirm(localIso);
  };

  return (
    <div className="relative w-full">

      {/* Header semplice */}
      <div className="mb-3 text-center font-medium text-gray-700">
        {step === "day" ? "Seleziona giorno" : "Seleziona ora"}
      </div>

      {/* Tab Oggi/Domani/Altro */}
      {step === "day" && tab !== "altro" && (
        <div className="flex justify-around mb-2">
          {["oggi", "domani", "altro"].map((t) => (
            <button
              key={t}
              onClick={() => selectTab(t as any)}
              className={`px-4 py-2 rounded-full text-sm font-medium
                ${tab === t ? "bg-[#ff3036] text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {t === "oggi" ? "Oggi" : t === "domani" ? "Domani" : "Altro"}
            </button>
          ))}
        </div>
      )}

      {/* Step Altro con tab mesi */}
      {step === "day" && tab === "altro" && (
        <>
          <div className="flex gap-2 overflow-x-auto mb-2 px-1">
            {monthLabels.map((m, idx) => (
              <button
                key={m}
                onClick={() => setCurrentMonthIndex(idx)}
                className={`flex-shrink-0 px-3 py-1 rounded-full text-sm font-medium
                  ${idx === currentMonthIndex ? "bg-[#ff3036] text-white" : "bg-gray-100 text-gray-700"}`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex gap-2 overflow-x-auto py-2 scroll-snap-x">
            {days
              .filter(d => d.getMonth() === currentMonthIndex)
              .map((d, idx) => (
                <button
                  key={idx}
                  onClick={() => setSelectedDay(d)}
                  className={`flex flex-col items-center justify-center min-w-[60px] p-2 rounded-lg
                    ${d.toDateString() === selectedDay.toDateString() ? "bg-[#ffe5e5]" : "bg-gray-50"}
                    scroll-snap-align-start`}
                >
                  <span className="text-xs text-gray-400">{d.toLocaleDateString("it-IT", { weekday: "short" })}</span>
                  <span className="font-bold text-lg text-gray-700">{d.getDate()}</span>
                </button>
              ))}
          </div>

          <div className="mt-4 flex justify-end">
            <button
              onClick={() => setStep("hour")}
              className="bg-[#ff3036] text-white px-4 py-2 rounded hover:bg-red-600"
            >
              Avanti
            </button>
          </div>
        </>
      )}

      {/* Step Ora */}
      {step === "hour" && (
        <div className="flex gap-2 overflow-x-auto py-2 scroll-snap-x">
          {HOURS.map((h) => (
            <button
              key={h}
              onClick={() => setSelectedHour(h)}
              className={`min-w-[60px] py-2 px-3 rounded-lg flex-shrink-0
                ${h === selectedHour ? "bg-[#ffe5e5]" : "bg-gray-50"}
                scroll-snap-align-start text-center`}
            >
              {h.toString().padStart(2, "0")}:00
            </button>
          ))}
        </div>
      )}

      {/* Pulsante Conferma */}
      {step === "hour" && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleConfirm}
            className="bg-[#ff3036] text-white px-4 py-2 rounded hover:bg-red-600"
          >
            Conferma
          </button>
        </div>
      )}
    </div>
  );
}