import React, { useEffect, useState } from "react";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";

export default function Profile({ user, userMeta }) {
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    university: "",
    country: "United States",
    city: "",
    region: "",
    postalCode: ""
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (userMeta) {
      setFormData({
        firstName: userMeta.firstName || "",
        lastName: userMeta.lastName || "",
        university: userMeta.university || "",
        country: userMeta.country || "United States",
        city: userMeta.city || "",
        region: userMeta.region || "",
        postalCode: userMeta.postalCode || ""
      });
    }
  }, [userMeta]);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  async function handleSave(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid), {
        ...formData,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-12 py-10">
      <div className="section-grid">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Personal Information</h2>
          <p className="mt-1 text-sm text-gray-600">Update your profile details and location settings.</p>
        </div>

        <div className="grid max-w-2xl grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-gray-900">First name</label>
            <div className="mt-2">
              <input type="text" name="firstName" value={formData.firstName} onChange={handleChange} className="input-standard" />
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-gray-900">Last name</label>
            <div className="mt-2">
              <input type="text" name="lastName" value={formData.lastName} onChange={handleChange} className="input-standard" />
            </div>
          </div>

          <div className="sm:col-span-4">
            <label className="block text-sm font-medium text-gray-900">Email address</label>
            <div className="mt-2">
              <input type="email" value={user.email} disabled className="input-standard bg-gray-50 text-gray-500 cursor-not-allowed border-gray-100" />
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-gray-900">Country</label>
            <div className="mt-2">
              <select name="country" value={formData.country} onChange={handleChange} className="input-standard">
                <option>United States</option>
                <option>Canada</option>
                <option>Mexico</option>
                <option>United Kingdom</option>
                <option>India</option>
              </select>
            </div>
          </div>

          <div className="col-span-full">
            <label className="block text-sm font-medium text-gray-900">University</label>
            <div className="mt-2">
              <input type="text" name="university" value={formData.university} onChange={handleChange} className="input-standard" placeholder="Enter your university" />
            </div>
          </div>

          <div className="sm:col-span-2 sm:col-start-1">
            <label className="block text-sm font-medium text-gray-900">City</label>
            <div className="mt-2">
              <input type="text" name="city" value={formData.city} onChange={handleChange} className="input-standard" />
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-900">State / Province</label>
            <div className="mt-2">
              <input type="text" name="region" value={formData.region} onChange={handleChange} className="input-standard" />
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-900">ZIP / Postal code</label>
            <div className="mt-2">
              <input type="text" name="postalCode" value={formData.postalCode} onChange={handleChange} className="input-standard" />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-x-6">
        {saved && <span className="text-sm font-medium text-green-600">Profile Updated!</span>}
        <button type="submit" disabled={busy} className="btn-primary min-w-[120px]">
          {busy ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </form>
  );
}