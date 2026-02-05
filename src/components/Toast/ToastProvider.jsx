import { createContext, useCallback, useContext, useEffect, useState } from "react";
import ToastManager from "./ToastManager.jsx";
import { generateToastId, defaultToastDuration } from "./toastUtils.js";

const ToastCtx = createContext({ showToast: () => {} });

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = "success", duration = defaultToastDuration) => {
    const id = generateToastId();
    const toast = { id, message, type };

    setToasts((prev) => [...prev, toast]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastCtx.Provider value={{ showToast }}>
      {children}
      <ToastManager toasts={toasts} removeToast={removeToast} />
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);