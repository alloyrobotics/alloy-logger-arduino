import time, sys
t0 = time.time()
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TDF import TDF_LabelSequence
doc = TDocStd_Document(TCollection_ExtendedString("doc"))
reader = STEPCAFControl_Reader()
reader.SetNameMode(True)
stat = reader.ReadFile("full-assembly.step")
print("read status:", stat, f"{time.time()-t0:.0f}s", flush=True)
ok = reader.Transfer(doc)
print("transfer:", ok, f"{time.time()-t0:.0f}s", flush=True)
tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
labels = TDF_LabelSequence()
tool.GetFreeShapes(labels)
print("free shapes:", labels.Length(), flush=True)
