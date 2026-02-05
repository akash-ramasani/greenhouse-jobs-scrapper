export const toastTypes = {
  SUCCESS: "success",
  ERROR: "error",
  INFO: "info",
};

export const defaultToastDuration = 3000;

export const generateToastId = () => Math.random().toString(36).substr(2, 9);