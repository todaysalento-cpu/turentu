// turentu-frontend/utils/serviziIcons.ts
import { FaWifi } from "react-icons/fa";
import { MdAcUnit } from "react-icons/md"; // aria condizionata

export const servizioIconMap: Record<string, JSX.Element> = {
  wifi: <FaWifi className="inline mr-1" />,
  "aria condizionata": <MdAcUnit className="inline mr-1" />,
};
