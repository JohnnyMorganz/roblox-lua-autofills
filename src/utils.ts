import * as vscode from "vscode"
import { ApiClass, ApiMember, ApiParameter, ApiValueType, getApiDump } from "./dump"
import { AutocompleteGroup, getAutocompleteDump } from "./autocompleteDump"

export const getServices: Promise<Map<string, ApiClass>> = (async () => {
    const apiDump = await getApiDump()
    const output = new Map()

    for (const klass of apiDump.Classes) {
        if (klass.Tags !== undefined && klass.Tags.includes("Service")) {
            output.set(klass.Name, klass)
        }
    }

    return output
})()

const isVariableClass = (variable: ApiClass | AutocompleteGroup): variable is ApiClass => {
    return (variable as ApiClass).Name !== undefined
}

// Heuristic method in order to infer the type of parts of a codeblock
// Codeblocks can be things like `Lighting.Ambient.R`
export const inferType = async (document: vscode.TextDocument | null, code: string) => {
    const codeSplit = code.split(".")
    const apiDump = await getApiDump()
    const autocompleteDump = await getAutocompleteDump()
    const services = await getServices

    const output = new Map<string, ApiValueType>()

    let lastVariableInfo: ApiClass | AutocompleteGroup | undefined
    while (codeSplit.length > 0) {
        const variable = codeSplit.shift() as string

        if (lastVariableInfo) {
            if (isVariableClass(lastVariableInfo)) {
                // lastVariableInfo is a Class from the API Dump
                const member = lastVariableInfo.Members.find(member => member.Name === variable)
                if (member) {
                    if (member.MemberType === "Property") {
                        output.set(variable, member.ValueType)
                        if (member.ValueType.Category === "Class") {
                            const info = apiDump.Classes.find(klass => klass.Name === member.ValueType.Name)
                            if (info) {
                                lastVariableInfo = info
                            } else {
                                // Cannot find class, therefore cannot infer type
                                break
                            }
                        } else if (member.ValueType.Category === "DataType") {
                            const info = autocompleteDump.ItemStruct.find(
                                struct => struct.name === member.ValueType.Name)
                            if (info) {
                                lastVariableInfo = info
                            } else {
                                // Cannot find DataType, therefore cannot infer type
                                break
                            }
                        } else {
                            // This value is most likely a primitive or an Enum
                            // There is nothing we can really infer from here, therefore we will break
                            // TODO: look into seeing if there is more we can infer
                            break
                        }
                    } else if (member.MemberType === "Event") {
                        // Return an EventInstance DataType
                        output.set(variable, { Category: "DataType", Name: "EventInstance" })
                        lastVariableInfo = autocompleteDump.ItemStruct.find(struct => struct.name === "EventInstance")
                        if (lastVariableInfo === undefined) {
                            // Break if EventInstance couldn't be found, as the type cannot be inferred
                            break
                        }
                    }
                } else {
                    // Can no longer infer a type
                    // Break the loop and return the output
                    break
                }
            } else {
                // lastVariableInfo is an ItemStruct from the Autocomplete Dump
                const property = lastVariableInfo.properties.find(
                    property => property.name === variable && property.static === false)
                if (property) {
                    // Need to infer if the property is a Class or a DataType
                    const classInfo = apiDump.Classes.find(klass => klass.Name === property.type)
                    if (classInfo) {
                        // The property is a Class
                        lastVariableInfo = classInfo
                        output.set(variable, { Category: "Class", Name: classInfo.Name })
                    } else {
                        const dataTypeInfo = autocompleteDump.ItemStruct.find(struct => struct.name === property.type)
                        if (dataTypeInfo) {
                            // The property is a DataType
                            lastVariableInfo = dataTypeInfo
                            output.set(variable, { Category: "DataType", Name: dataTypeInfo.name })
                        } else {
                            // Cannot find the type of this property
                            // It may be a primitive? Cannot determine right now <- TODO
                            // Breaking the loop
                            break
                        }
                    }
                }
            }
        } else {
            // First part of chain, need to determine what type it is
            // This can be done by checking if its a Service
            // or by looking above the line for variable assignment

            const service = services.get(variable)
            if (service) {
                lastVariableInfo = service
                output.set(variable, { Category: "Class", Name: service.Name })
                continue
            }
            // TODO: Check for variable assignment

            // We were unable to find anything, so we just need to break
            break
        }
    }

    // TODO: Split the code to find a function

    return output
}