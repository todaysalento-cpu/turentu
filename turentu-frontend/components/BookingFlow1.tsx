'use client';

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import StepDettagli from "./steps/StepDettagli";
import StepConferma from "./steps/StepConferma";
import StepPagamento from "./steps/StepPagamento";

type FlowType = "prenota" | "richiedi";

interface Props {
  open: boolean;
  type: FlowType;
  onClose: () => void;
  prezzo: number;
}

export default function BookingFlow({ open, type, onClose, prezzo }: Props) {
  const [step, setStep] = useState(0);

  const next = () => setStep((s) => s + 1);
  const back = () => setStep((s) => s - 1);

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
                    step >= i ? "bg-[#ff3036]" : "bg-gray-300"
                  }`}
                />
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {step === 0 && (
                <StepDettagli type={type} onNext={next} />
              )}

              {step === 1 && (
                <StepConferma type={type} prezzo={prezzo} onNext={next} onBack={back} />
              )}

              {step === 2 && (
                <StepPagamento type={type} prezzo={prezzo} onClose={onClose} />
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
