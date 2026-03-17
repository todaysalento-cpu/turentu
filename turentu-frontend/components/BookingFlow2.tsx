'use client';

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import StepDettagli from "./steps/StepDettagli";
import StepConferma from "./steps/StepConferma";
import StepPagamento from "./steps/StepPagamento";

type FlowType = "prenota" | "richiedi";

interface Props {
  open: boolean;
  type: FlowType;
  onClose: () => void;
  prezzo?: number; // prezzo opzionale
  onConfirm?: () => Promise<void> | void; // callback finale per confermare prenotazione
  localitaOrigine?: string;
  localitaDestinazione?: string;
  datetime?: string;
  posti?: number;
}

export default function BookingFlow({
  open,
  type,
  onClose,
  prezzo = 0,
  onConfirm,
  localitaOrigine = "N/D",
  localitaDestinazione = "N/D",
  datetime = new Date().toISOString(),
  posti = 1
}: Props) {
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false); // stato conferma completata

  // Reset step e conferma quando il flusso si apre
  useEffect(() => {
    if (open) {
      setStep(0);
      setConfirmed(false);
    }
  }, [open]);

  const next = () => setStep((s) => Math.min(s + 1, 2));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const handleConfirm = async () => {
    console.log(`Autorizzazione ${type} confermata, prezzo: ${prezzo}`);
    if (onConfirm) await onConfirm(); // chiamata al backend o logica conferma
    setConfirmed(true); // passa allo step di conferma completata
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Overlay */}
          <motion.div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Sheet */}
          <motion.div
            className="fixed inset-x-0 bottom-0 top-0 bg-white z-50 rounded-t-2xl flex flex-col"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25 }}
          >
            {/* Stepper */}
            <div className="flex justify-center gap-2 py-3 border-b">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`h-2 w-2 rounded-full ${
                    step >= i || confirmed ? "bg-[#ff3036]" : "bg-gray-300"
                  }`}
                />
              ))}
            </div>

            {/* Step content */}
            <div className="flex-1 overflow-y-auto p-4">
              {!confirmed && step === 0 && (
                <StepDettagli
                  type={type}
                  onNext={next}
                  localitaOrigine={localitaOrigine}
                  localitaDestinazione={localitaDestinazione}
                  datetime={datetime}
                  posti={posti}
                  prezzo={prezzo}
                />
              )}

              {!confirmed && step === 1 && (
                <StepConferma
                  type={type}
                  prezzo={prezzo}
                  onNext={next}
                  onBack={back}
                />
              )}

              {!confirmed && step === 2 && (
                <StepPagamento
                  type={type}
                  prezzo={prezzo}
                  onBack={back} // permette tornare indietro
                  onConfirm={handleConfirm} // conferma finale
                />
              )}

              {/* Step conferma completata */}
              {confirmed && (
                <div className="flex flex-col items-center justify-center h-full p-4 text-center">
                  <h2 className="text-2xl font-bold mb-4">Prenotazione completata!</h2>
                  <p className="mb-6">
                    La tua {type === "prenota" ? "prenotazione" : "richiesta"} è stata registrata con successo.
                  </p>
                  <button
                    className="px-6 py-3 bg-[#ff3036] text-white rounded-lg font-semibold"
                    onClick={onClose}
                  >
                    Chiudi
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
