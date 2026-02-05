import { motion } from "framer-motion";
import clsx from "clsx";
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
} from "@heroicons/react/20/solid";

export default function Toast({ message, type }) {
  const iconMap = {
    success: <CheckCircleIcon className="h-5 w-5 text-white shrink-0" />,
    error: <ExclamationCircleIcon className="h-5 w-5 text-white shrink-0" />,
    info: <InformationCircleIcon className="h-5 w-5 text-white shrink-0" />,
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className={clsx(
        "relative flex items-start gap-3 w-full max-w-xs rounded-lg px-4 py-3 text-sm shadow-lg",
        type === "success" && "bg-green-600 text-white",
        type === "error" && "bg-red-600 text-white",
        type === "info" && "bg-blue-600 text-white"
      )}
    >
      {iconMap[type]}
      <span className="flex-1">{message}</span>
    </motion.div>
  );
}