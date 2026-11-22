import { createContext, useContext } from "react";
import { strings, type Strings } from "./strings.ts";

export const I18n = createContext<Strings>(strings.hans);
export const useT = () => useContext(I18n);
