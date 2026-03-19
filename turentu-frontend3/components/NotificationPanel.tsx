'use client';
import { useState } from 'react';
import { useNotifications } from '@/context/NotificationContext';

export default function NotificationPanel() {
  const { notifications, markAsSeen, pendingCount } = useNotifications();
  const [open, setOpen] = useState(true); // stato apertura

  if (!open) return (
    <button
      className="fixed top-4 right-4 bg-blue-600 text-white px-3 py-1 rounded shadow"
      onClick={() => setOpen(true)}
    >
      Mostra notifiche ({pendingCount})
    </button>
  );

  return (
    <div className="fixed top-4 right-4 w-96 z-50 space-y-2 bg-white p-2 rounded shadow">
      <div className="flex justify-between items-center mb-2">
        <h4 className="font-bold">Notifiche</h4>
        <button
          className="text-gray-500 hover:text-gray-700"
          onClick={() => setOpen(false)}
        >
          ✕
        </button>
      </div>

      {notifications.slice(0, 10).map(n => (
        <div
          key={n.id}
          className={`p-3 rounded shadow border-l-4 ${
            n.type === 'pending' && !n.seen
              ? 'border-yellow-500 bg-yellow-50'
              : 'border-blue-500 bg-white'
          }`}
        >
          <p className="font-bold">{n.type.toUpperCase()}</p>
          <p>{n.message}</p>
          <p className="text-xs text-gray-400">{n.displayDate}</p>
          {!n.seen && (
            <button
              className="text-blue-600 underline text-xs mt-1"
              onClick={() => markAsSeen(n.id)}
            >
              Segna come visto
            </button>
          )}
        </div>
      ))}

      {pendingCount > 0 && (
        <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
          {pendingCount}
        </span>
      )}
    </div>
  );
}