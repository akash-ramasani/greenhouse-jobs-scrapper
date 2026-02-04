import React from "react";

export default function AppShell({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md surface shadow-sm p-6">
        {children}
      </div>
    </div>
  );
}
