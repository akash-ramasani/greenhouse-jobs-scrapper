import React from "react";
import { motion } from "framer-motion";

export default function Card({ children, className = "" }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`soft-card grain p-6 ${className}`}
    >
      {children}
    </motion.div>
  );
}
